import { MetaFailure } from './models.js';
import type { Message, Messenger, WhatsAppEnvironment } from './models.js';

/** Deliberately no automatic HTTP retry: send outcomes can be ambiguous. */
export class MetaClient implements Messenger {
  constructor(
    private readonly env: WhatsAppEnvironment,
    private readonly http: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}
  async send(
    phoneNumberId: string,
    recipient: string,
    message: Message,
  ): Promise<string> {
    const version = this.env.WHATSAPP_GRAPH_VERSION || 'v25.0';
    if (
      !this.env.META_ACCESS_TOKEN ||
      !/^v\d+\.0$/.test(version) ||
      !/^\d+$/.test(phoneNumberId) ||
      !/^[1-9]\d{7,14}$/.test(recipient)
    )
      throw new MetaFailure('Configuration');
    if (
      !message.body ||
      message.body.length > (message.type === 'text' ? 4096 : 1024)
    )
      throw new MetaFailure('Rejected');
    if (
      message.type !== 'text' &&
      (message.choices.length < 1 ||
        message.choices.length > (message.type === 'buttons' ? 3 : 10) ||
        message.choices.some(
          (c) =>
            !c.id ||
            c.id.length > 200 ||
            !c.title ||
            c.title.length > (message.type === 'buttons' ? 20 : 24) ||
            (c.description?.length ?? 0) > 72,
        ) ||
        new Set(message.choices.map((c) => c.id)).size !==
          message.choices.length)
    )
      throw new MetaFailure('Rejected');
    const content =
      message.type === 'text'
        ? { type: 'text', text: { body: message.body, preview_url: false } }
        : {
            type: 'interactive',
            interactive: {
              type: message.type === 'buttons' ? 'button' : 'list',
              body: { text: message.body },
              action:
                message.type === 'buttons'
                  ? {
                      buttons: message.choices.map((reply) => ({
                        type: 'reply',
                        reply: { id: reply.id, title: reply.title },
                      })),
                    }
                  : { button: 'Choose', sections: [{ rows: message.choices }] },
            },
          };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Worker fetch rejects a class instance as its receiver.
      const request = this.http;
      const response = await request(
        `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.env.META_ACCESS_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipient,
            ...content,
          }),
        },
      );
      if (!response.ok) {
        const status = response.status;
        const retry = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        throw new MetaFailure(
          status === 429
            ? 'RateLimited'
            : status === 401 || status === 403
              ? 'Authentication'
              : status >= 400 && status < 500
                ? 'Rejected'
                : 'Uncertain',
          Number.isFinite(retry)
            ? Math.min(3_600_000, Math.max(0, retry * 1000))
            : 0,
        );
      }
      const data = (await response.json()) as { messages?: { id?: unknown }[] };
      const id = data.messages?.[0]?.id;
      if (typeof id !== 'string' || !id || id.length > 256)
        throw new MetaFailure('Uncertain');
      return id;
    } catch (error) {
      if (error instanceof MetaFailure) throw error;
      throw new MetaFailure('Uncertain');
    } finally {
      clearTimeout(timer);
    }
  }
}
