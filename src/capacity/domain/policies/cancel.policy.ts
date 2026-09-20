import { Result, err, ok } from '../../../shared/result';
import { ReservationSnapshot } from './release.policy';

export type CancelRefusal = 'RESERVATION_TERMINAL';

export interface CancelDecision {
  /** Positive magnitude of capacity returned. The service negates it. */
  readonly deltaMinor: bigint;
  readonly cause: 'CANCELLATION' | 'WRITE_OFF';
  readonly status: 'CANCELLED' | 'WRITTEN_OFF';
}

const TERMINAL_STATUSES: ReadonlySet<ReservationSnapshot['status']> = new Set([
  'FULLY_RELEASED',
  'CANCELLED',
  'WRITTEN_OFF',
]);

// The cause is chosen by what already happened to the reservation, never by the
// caller: an untouched reservation is a cancellation, one with repaid capacity
// is a write-off of what the invoice still owed.
export function cancelPolicy(
  reservation: ReservationSnapshot,
): Result<CancelDecision, CancelRefusal> {
  if (TERMINAL_STATUSES.has(reservation.status)) {
    return err('RESERVATION_TERMINAL');
  }

  if (reservation.status === 'PARTIALLY_RELEASED') {
    return ok({
      deltaMinor: reservation.outstandingReservedMinor,
      cause: 'WRITE_OFF',
      status: 'WRITTEN_OFF',
    });
  }

  return ok({
    deltaMinor: reservation.outstandingReservedMinor,
    cause: 'CANCELLATION',
    status: 'CANCELLED',
  });
}
