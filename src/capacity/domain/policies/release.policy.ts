import { Result, err, ok } from '../../../shared/result';
import { convert, money } from '../../../shared/money';

export type ReservationStatus =
  | 'ACTIVE'
  | 'PARTIALLY_RELEASED'
  | 'FULLY_RELEASED'
  | 'CANCELLED'
  | 'WRITTEN_OFF';

/** The readonly domain view of a reservation the policy decides on. */
export interface ReservationSnapshot {
  readonly invoiceCurrency: string;
  readonly programCurrency: string;
  readonly outstandingInvoiceMinor: bigint;
  readonly outstandingReservedMinor: bigint;
  readonly status: ReservationStatus;
}

export interface ReleaseInput {
  readonly releaseMinor: bigint;
  readonly releaseCurrency: string;
  readonly reservation: ReservationSnapshot;
  /** scaleRate(reservation.fxRate ?? '1.0'). */
  readonly scaledRate: bigint;
}

export type ReleaseRefusal =
  | 'INVALID_AMOUNT'
  | 'CURRENCY_MISMATCH'
  | 'RESERVATION_TERMINAL'
  | 'RELEASE_EXCEEDS_RESERVED'
  | 'AMOUNT_ROUNDS_TO_ZERO';

export interface ReleaseDecision {
  /** Positive magnitude of capacity returned, converted into the program currency. */
  readonly deltaMinor: bigint;
  readonly outstandingInvoiceMinor: bigint;
  readonly outstandingReservedMinor: bigint;
  readonly status: 'PARTIALLY_RELEASED' | 'FULLY_RELEASED';
}

const TERMINAL_STATUSES: ReadonlySet<ReservationStatus> = new Set([
  'FULLY_RELEASED',
  'CANCELLED',
  'WRITTEN_OFF',
]);

export function releasePolicy(
  input: ReleaseInput,
): Result<ReleaseDecision, ReleaseRefusal> {
  const { releaseMinor, releaseCurrency, reservation, scaledRate } = input;

  if (releaseMinor <= 0n) {
    return err('INVALID_AMOUNT');
  }

  if (releaseCurrency !== reservation.invoiceCurrency) {
    return err('CURRENCY_MISMATCH');
  }

  if (TERMINAL_STATUSES.has(reservation.status)) {
    return err('RESERVATION_TERMINAL');
  }

  // A release can never exceed what remains on the invoice. Without this a
  // sub-1 rate could convert a release that is larger than the outstanding
  // invoice into a delta within the reserved remainder, driving the invoice
  // outstanding negative.
  if (releaseMinor > reservation.outstandingInvoiceMinor) {
    return err('RELEASE_EXCEEDS_RESERVED');
  }

  // A release whose own converted value is below one minor unit returns no
  // capacity while still reducing the invoice; it is refused, never applied.
  const releaseConversion = convert(
    money(releaseMinor, releaseCurrency),
    reservation.programCurrency,
    scaledRate,
  );
  if (releaseConversion.kind === 'roundsToZero') {
    return err('AMOUNT_ROUNDS_TO_ZERO');
  }

  // The reserved capacity is the converted outstanding invoice, so the capacity
  // returned is the difference between the converted invoice before and after
  // the release — not the release converted on its own. Deriving it this way
  // keeps `outstanding_reserved_minor === round_half_up(outstanding_invoice_minor
  // * rate)` true at every step, so a sub-1 rate cannot drain the reserved
  // remainder ahead of the invoice and strand it short of FULLY_RELEASED.
  const outstandingInvoiceMinor =
    reservation.outstandingInvoiceMinor - releaseMinor;
  const remainderConversion = convert(
    money(outstandingInvoiceMinor, reservation.programCurrency),
    reservation.programCurrency,
    scaledRate,
  );
  const remainderReservedMinor =
    remainderConversion.kind === 'converted'
      ? remainderConversion.amount.minor
      : 0n;
  const deltaMinor =
    reservation.outstandingReservedMinor - remainderReservedMinor;

  // An inconsistent reservation (its reserved is below the converted invoice)
  // is refused rather than clamped.
  if (deltaMinor < 0n) {
    return err('RELEASE_EXCEEDS_RESERVED');
  }

  // The release moves no capacity, so it would shrink the invoice for free.
  if (deltaMinor === 0n) {
    return err('AMOUNT_ROUNDS_TO_ZERO');
  }

  // FR-009b: a remainder worth less than one minor unit is sub-unit dust and is
  // settled in full, so the reservation is not left stranded below
  // FULLY_RELEASED with unreleasable capacity.
  if (remainderReservedMinor === 0n) {
    return ok({
      deltaMinor,
      outstandingInvoiceMinor: 0n,
      outstandingReservedMinor: 0n,
      status: 'FULLY_RELEASED',
    });
  }

  return ok({
    deltaMinor,
    outstandingInvoiceMinor,
    outstandingReservedMinor: remainderReservedMinor,
    status:
      outstandingInvoiceMinor === 0n ? 'FULLY_RELEASED' : 'PARTIALLY_RELEASED',
  });
}
