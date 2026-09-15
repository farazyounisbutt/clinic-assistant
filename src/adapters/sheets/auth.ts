import type { Clock } from '../../ports/runtime.js';
import { ProjectionFailure } from '../../projection/errors.js';
import { googleJson } from './http.js';
import type { GoogleFetch } from './http.js';
export interface GoogleTokenProvider {
  getToken(): Promise<string>;
  invalidate(): void;
}
export interface ServiceAccountCredentials {
  readonly email: string;
  readonly privateKey: string;
}
const audience = 'https://oauth2.googleapis.com/token';
const scope = 'https://www.googleapis.com/auth/spreadsheets';
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
function encoded(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}
/** Fixed RS256 JWT bearer grant, with signing exclusively delegated to Web Crypto. */
export class GoogleServiceAccountTokens implements GoogleTokenProvider {
  private token: { value: string; expiresAt: number } | undefined;
  private pending: Promise<string> | undefined;
  private key: CryptoKey | undefined;
  constructor(
    private readonly credentials: ServiceAccountCredentials,
    private readonly clock: Clock,
    private readonly request: GoogleFetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}
  invalidate(): void {
    this.token = undefined;
  }
  async getToken(): Promise<string> {
    if (
      this.token &&
      this.token.expiresAt > this.clock.now().getTime() + 60_000
    )
      return this.token.value;
    if (this.pending) return this.pending;
    this.pending = this.acquire();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
  private async assertion(): Promise<string> {
    try {
      if (!this.credentials.email.trim()) throw new Error();
      if (!this.key) {
        const pem = this.credentials.privateKey.replace(/\\n/g, '\n').trim();
        const match =
          /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----$/.exec(
            pem,
          );
        if (!match) throw new Error();
        const der = Uint8Array.from(atob(match[1]!.replace(/\s/g, '')), (c) =>
          c.charCodeAt(0),
        );
        this.key = await crypto.subtle.importKey(
          'pkcs8',
          der,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['sign'],
        );
      }
      const issued = Math.floor(this.clock.now().getTime() / 1000);
      const input = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ iss: this.credentials.email, scope, aud: audience, iat: issued, exp: issued + 3600 })}`;
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        this.key,
        new TextEncoder().encode(input),
      );
      return `${input}.${base64url(new Uint8Array(signature))}`;
    } catch {
      throw new ProjectionFailure('Authentication');
    }
  }
  private async acquire(): Promise<string> {
    const acquiredAt = this.clock.now().getTime();
    const assertion = await this.assertion();
    const response = await googleJson(
      this.request,
      audience,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      },
      this.timeoutMs,
      true,
    );
    if (
      !response ||
      typeof response !== 'object' ||
      !('access_token' in response) ||
      typeof response.access_token !== 'string' ||
      !response.access_token ||
      !('expires_in' in response) ||
      typeof response.expires_in !== 'number' ||
      !Number.isFinite(response.expires_in) ||
      response.expires_in <= 60
    )
      throw new ProjectionFailure('Authentication');
    this.token = {
      value: response.access_token,
      expiresAt: acquiredAt + Math.min(response.expires_in, 3600) * 1000,
    };
    return this.token.value;
  }
}
