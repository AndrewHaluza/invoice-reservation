export type AcknowledgementKind = 'EXPLICIT' | 'WATERMARK';

/**
 * The acknowledgement marker a snapshot carried (FR-011a). `EXPLICIT` names the
 * reservations by `treasury_reference`; `WATERMARK` acknowledges every local
 * reservation confirmed at or before `ingestedThrough`. Exactly one of
 * `reservationReferences` / `ingestedThrough` is non-null, mirroring the
 * `snapshot_acknowledgement` CHECK constraints.
 */
export interface SnapshotMarker {
  readonly kind: AcknowledgementKind;
  readonly reservationReferences: readonly string[] | null;
  readonly ingestedThrough: Date | null;
}

export interface ReconciliationSnapshot {
  readonly messageId: string;
  readonly programId: string;
  readonly version: bigint;
  readonly effectiveAt: Date;
  readonly correlationId: string | null;
  readonly currency: string;
  readonly creditLimitMinor: bigint;
  readonly reservedMinor: bigint;
  /**
   * `null` when the snapshot carried no acknowledgement marker. Such a snapshot
   * is quarantined `MISSING_ACK_MARKER` (FR-011b); the additive rule cannot be
   * applied without one.
   */
  readonly acknowledgement: SnapshotMarker | null;
}
