/** Delivery mechanism is chosen by an adapter, never by appointment logic. */
export interface Message {
  readonly clinicId: string;
  readonly recipient: string;
  readonly text: string;
}

export interface MessagingPort {
  send(message: Message): Promise<void>;
}
