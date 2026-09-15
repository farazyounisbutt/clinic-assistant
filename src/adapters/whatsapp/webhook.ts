import type {
  Batch,
  Incoming,
  Input,
  StatusEvent,
  WhatsAppEnvironment,
} from './models.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid webhook');
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid webhook');
  return value;
}
function string(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max)
    throw new Error('Invalid webhook');
  return value;
}
function numberId(value: unknown): string {
  const id = string(value, 30);
  if (!/^[1-9]\d{7,29}$/.test(id)) throw new Error('Invalid identifier');
  return id;
}
function timestamp(value: unknown): number {
  const raw = string(value, 16);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw) * 1000))
    throw new Error('Invalid timestamp');
  return Number(raw) * 1000;
}
/** Allowlist only operational fields; never retain profiles, media, or full webhooks. */
export function parseWebhook(value: unknown): Batch[] {
  const root = object(value);
  if (root.object !== 'whatsapp_business_account')
    throw new Error('Invalid webhook');
  const batches: Batch[] = [];
  let count = 0;
  for (const entry of array(root.entry))
    for (const change of array(object(entry).changes)) {
      const c = object(change);
      if (c.field !== 'messages') continue;
      const v = object(c.value);
      const phoneNumberId = numberId(object(v.metadata).phone_number_id);
      const messages: Incoming[] = array(v.messages ?? []).map((raw) => {
        const m = object(raw);
        let input: Input = { type: 'unsupported', value: '' };
        if (m.type === 'text') {
          const text = string(object(m.text).body, 4096);
          // Oversized free text is unsupported, never persisted as a clinical/chat history.
          if (text.length <= 160) input = { type: 'text', value: text.trim() };
        }
        if (m.type === 'interactive') {
          const interactive = object(m.interactive);
          if (
            interactive.type === 'button_reply' ||
            interactive.type === 'list_reply'
          )
            input = {
              type: 'action',
              value: string(object(interactive[interactive.type]).id, 200),
            };
        }
        const sender = numberId(m.from);
        if (sender.length > 15) throw new Error('Invalid contact');
        return {
          id: string(m.id),
          sender,
          timestamp: timestamp(m.timestamp),
          input,
        };
      });
      const statuses: StatusEvent[] = [];
      for (const raw of array(v.statuses ?? [])) {
        const s = object(raw);
        if (
          s.status === 'sent' ||
          s.status === 'delivered' ||
          s.status === 'read' ||
          s.status === 'failed'
        )
          statuses.push({
            id: string(s.id),
            recipient: numberId(s.recipient_id),
            timestamp: timestamp(s.timestamp),
            status: s.status,
          });
      }
      count += messages.length + statuses.length;
      if (count > 100) throw new Error('Batch too large');
      batches.push({ phoneNumberId, messages, statuses });
    }
  return batches;
}
export async function verifySignature(
  body: Uint8Array,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature))
    return false;
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, (hex) =>
    Number.parseInt(hex, 16),
  );
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, bytes, body);
}
/** Body limit applies during streaming, even without Content-Length. */
async function readBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new Error('Missing body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 262144) {
        await reader.cancel();
        throw new Error('Body too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
export async function webhook(
  request: Request,
  env: WhatsAppEnvironment,
  enqueue: (clinicId: string, batch: Batch) => Promise<void>,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/webhooks/whatsapp')
    return new Response('Not found', { status: 404 });
  if (request.method === 'GET') {
    const challenge = url.searchParams.get('hub.challenge');
    if (
      env.WHATSAPP_VERIFY_TOKEN &&
      url.searchParams.get('hub.mode') === 'subscribe' &&
      url.searchParams.get('hub.verify_token') === env.WHATSAPP_VERIFY_TOKEN &&
      challenge &&
      challenge.length <= 256
    )
      return new Response(challenge, {
        headers: { 'content-type': 'text/plain' },
      });
    return new Response('Forbidden', { status: 403 });
  }
  if (request.method !== 'POST')
    return new Response('Method not allowed', { status: 405 });
  if (!env.META_APP_SECRET || !env.WHATSAPP_PHONE_CLINICS)
    return new Response('Unavailable', { status: 503 });
  let body: Uint8Array;
  try {
    body = await readBody(request);
  } catch {
    return new Response('Invalid payload', { status: 400 });
  }
  if (
    !(await verifySignature(
      body,
      request.headers.get('x-hub-signature-256'),
      env.META_APP_SECRET,
    ))
  )
    return new Response('Forbidden', { status: 403 });
  let routes: { clinicId: string; batch: Batch }[];
  try {
    const mapping = object(JSON.parse(env.WHATSAPP_PHONE_CLINICS));
    routes = parseWebhook(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
          body,
        ),
      ),
    ).map((batch) => {
      if (!Object.hasOwn(mapping, batch.phoneNumberId))
        throw new Error('Unknown phone ID');
      return { clinicId: string(mapping[batch.phoneNumberId], 128), batch };
    });
  } catch {
    return new Response('Invalid payload or routing', { status: 400 });
  }
  try {
    for (const route of routes) await enqueue(route.clinicId, route.batch);
  } catch {
    return new Response('Unavailable', { status: 503 });
  }
  return new Response('OK');
}
