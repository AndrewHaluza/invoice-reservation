export type PositionComponent = 'LOCAL' | 'TREASURY' | 'LIMIT';

export type LedgerCause =
  | 'RESERVATION'
  | 'RELEASE'
  | 'CANCELLATION'
  | 'WRITE_OFF'
  | 'TREASURY_EVENT'
  | 'LIMIT_CHANGE'
  | 'RECONCILIATION_ADJUSTMENT'
  | 'OVER_LIMIT_ONSET'
  | 'OVER_LIMIT_CLEARED';

/** An entry as requested by a caller, before a sequence is assigned. */
export interface PendingLedgerEntry {
  readonly deltaMinor: bigint;
  readonly component: PositionComponent;
  readonly cause: LedgerCause;
  readonly originReference: string | null;
  readonly actor: string;
  readonly correlationId: string;
}

/** An entry with its per-program sequence assigned. */
export interface SequencedLedgerEntry extends PendingLedgerEntry {
  readonly sequence: bigint;
}
