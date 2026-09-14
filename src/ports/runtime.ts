export interface Clock {
  now(): Date;
}

export interface AppointmentIdGenerator {
  next(): string;
}
