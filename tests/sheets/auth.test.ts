import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleServiceAccountTokens } from '../../src/adapters/sheets/auth.js';
import { GoogleSheetsClient } from '../../src/adapters/sheets/client.js';

afterEach(() => vi.useRealTimers());
const clock = { now: () => new Date('2030-01-01T00:00:00Z') };
async function credentials() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  );
  const encoded = btoa(String.fromCharCode(...der));
  return {
    email: 'service@example.invalid',
    privateKey: [
      '-----BEGIN PRIVATE KEY-----',
      encoded,
      '-----END PRIVATE KEY-----',
    ].join('\\n'),
    publicKey: pair.publicKey,
  };
}
describe('Worker service-account authentication', () => {
  it('signs a valid RS256 assertion without delegation and reuses the token until near expiry', async () => {
    const creds = await credentials();
    let now = clock.now();
    let calls = 0;
    const tokens = new GoogleServiceAccountTokens(
      creds,
      { now: () => now },
      async (url, init) => {
        calls++;
        expect(String(url)).toBe('https://oauth2.googleapis.com/token');
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('grant_type')).toBe(
          'urn:ietf:params:oauth:grant-type:jwt-bearer',
        );
        const parts = body.get('assertion')!.split('.');
        const decode = (s: string) =>
          atob(s.replace(/-/g, '+').replace(/_/g, '/'));
        expect(JSON.parse(decode(parts[0]!))).toEqual({
          alg: 'RS256',
          typ: 'JWT',
        });
        const claims = JSON.parse(decode(parts[1]!));
        expect(claims).toMatchObject({
          iss: creds.email,
          aud: 'https://oauth2.googleapis.com/token',
          scope: 'https://www.googleapis.com/auth/spreadsheets',
        });
        expect(claims).not.toHaveProperty('sub');
        expect(claims.exp - claims.iat).toBe(3600);
        expect(
          await crypto.subtle.verify(
            'RSASSA-PKCS1-v1_5',
            creds.publicKey,
            Uint8Array.from(decode(parts[2]!), (c) => c.charCodeAt(0)),
            new TextEncoder().encode(parts.slice(0, 2).join('.')),
          ),
        ).toBe(true);
        return Response.json({
          access_token: `synthetic-${calls}`,
          expires_in: 3600,
          token_type: 'Bearer',
        });
      },
    );
    expect(await Promise.all([tokens.getToken(), tokens.getToken()])).toEqual([
      'synthetic-1',
      'synthetic-1',
    ]);
    now = new Date(now.getTime() + 3500_000);
    expect(await tokens.getToken()).toBe('synthetic-1');
    now = new Date(now.getTime() + 60_000);
    expect(await tokens.getToken()).toBe('synthetic-2');
    tokens.invalidate();
    expect(await tokens.getToken()).toBe('synthetic-3');
  });
  it('reports bad key material without exposing it or calling Google', async () => {
    const request = vi.fn();
    const tokens = new GoogleServiceAccountTokens(
      { email: 'service@example.invalid', privateKey: 'synthetic-invalid-key' },
      clock,
      request,
    );
    await expect(tokens.getToken()).rejects.toMatchObject({
      category: 'Authentication',
      message: 'Google service-account credentials are invalid',
    });
    expect(request).not.toHaveBeenCalled();
  });
});
describe('Google REST failures', () => {
  it.each([
    [403, 'Authorization'],
    [404, 'TargetUnavailable'],
    [400, 'Schema'],
    [429, 'RateLimited'],
    [503, 'Transient'],
  ] as const)('classifies HTTP %s safely', async (status, category) => {
    const client = new GoogleSheetsClient(
      { getToken: async () => 'synthetic-token', invalidate: () => {} },
      async () =>
        new Response('PRIVATE REMOTE BODY', {
          status,
          headers: { 'Retry-After': '120' },
        }),
    );
    await expect(client.get('synthetic-target')).rejects.toMatchObject({
      category,
    });
    try {
      await client.get('synthetic-target');
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE');
    }
  });
  it('refreshes once on 401 and stops if authorization still fails', async () => {
    const invalidate = vi.fn();
    let calls = 0;
    const client = new GoogleSheetsClient(
      { getToken: async () => 'synthetic-token', invalidate },
      async () => {
        calls++;
        return new Response('', { status: 401 });
      },
    );
    await expect(client.get('synthetic-target')).rejects.toMatchObject({
      category: 'Authentication',
    });
    expect(calls).toBe(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
  it('bounds hung HTTP calls with a timeout', async () => {
    vi.useFakeTimers();
    const client = new GoogleSheetsClient(
      { getToken: async () => 'synthetic-token', invalidate: () => {} },
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
      10,
    );
    const assertion = expect(
      client.get('synthetic-target'),
    ).rejects.toMatchObject({ category: 'Transient' });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });
});

it('refreshes a rejected bearer token once and succeeds', async () => {
  let calls = 0;
  const invalidate = vi.fn();
  const client = new GoogleSheetsClient(
    { getToken: async () => 'synthetic-token', invalidate },
    async () =>
      ++calls === 1
        ? new Response('', { status: 401 })
        : Response.json({ sheets: [] }),
  );
  expect(await client.get('synthetic-target')).toEqual({ sheets: [] });
  expect(invalidate).toHaveBeenCalledOnce();
});
it('classifies OAuth failure and refuses malformed token responses', async () => {
  const creds = await credentials();
  for (const response of [
    new Response('sensitive', { status: 400 }),
    Response.json({ access_token: '', expires_in: 3600 }),
    Response.json({ access_token: 'synthetic', expires_in: 20 }),
  ]) {
    const tokens = new GoogleServiceAccountTokens(
      creds,
      clock,
      async () => response,
    );
    await expect(tokens.getToken()).rejects.toMatchObject({
      category: 'Authentication',
    });
  }
});
it('classifies network and malformed success responses without leaking details', async () => {
  for (const request of [
    async () => {
      throw new Error('Sensitive diagnostic');
    },
    async () => new Response('not JSON'),
  ]) {
    const client = new GoogleSheetsClient(
      { getToken: async () => 'synthetic-token', invalidate: () => {} },
      request,
    );
    await expect(client.get('synthetic-target')).rejects.toMatchObject({
      category: 'Transient',
    });
  }
});
