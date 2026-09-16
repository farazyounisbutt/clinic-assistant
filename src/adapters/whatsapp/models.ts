export interface WhatsAppEnvironment {
  readonly WHATSAPP_OPERATORS?: string;
  readonly META_ACCESS_TOKEN?: string;
  readonly META_APP_SECRET?: string;
  readonly WHATSAPP_VERIFY_TOKEN?: string;
  readonly WHATSAPP_PHONE_CLINICS?: string;
  readonly WHATSAPP_GRAPH_VERSION?: string;
}
export interface Input {
  readonly type: 'text' | 'action' | 'unsupported';
  readonly value: string;
}
export interface Incoming {
  readonly id: string;
  readonly sender: string;
  readonly timestamp: number;
  readonly input: Input;
}
export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';
export interface StatusEvent {
  readonly id: string;
  readonly recipient: string;
  readonly status: DeliveryStatus;
  readonly timestamp: number;
}
export interface Batch {
  readonly phoneNumberId: string;
  readonly messages: readonly Incoming[];
  readonly statuses: readonly StatusEvent[];
}
export interface Choice {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}
export type Message =
  | { readonly type: 'text'; readonly body: string }
  | {
      readonly type: 'buttons' | 'list';
      readonly body: string;
      readonly choices: readonly Choice[];
    };
export interface Messenger {
  send(
    phoneNumberId: string,
    recipient: string,
    message: Message,
  ): Promise<string>;
}
export type MetaFailureCategory =
  'Configuration' | 'Rejected' | 'Authentication' | 'RateLimited' | 'Uncertain';
export class MetaFailure extends Error {
  constructor(
    readonly category: MetaFailureCategory,
    readonly retryAfterMs = 0,
  ) {
    super(`Meta messaging: ${category}`);
  }
}
