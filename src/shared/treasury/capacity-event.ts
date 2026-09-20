export type CapacityEventType =
  | 'LIMIT_CHANGED'
  | 'RESERVATION_BOOKED'
  | 'RESERVATION_RELEASED';

export interface CapacityEvent {
  readonly messageId: string;
  readonly programId: string;
  readonly version: bigint;
  readonly effectiveAt: Date;
  readonly correlationId: string | null;
  readonly type: CapacityEventType;
  readonly payload: {
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly reservationReference: string | null;
  };
}

export interface StreamCoordinates {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
}
