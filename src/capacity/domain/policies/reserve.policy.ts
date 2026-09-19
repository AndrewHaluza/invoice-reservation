import { convert, money } from '../../../shared/money';
import { RefusalCode } from '../errors';
import { FxRate } from '../ports/fx-rate.provider';
import { ProgramPosition, available, isOverLimit } from '../program';

export type FxResolution =
  | { readonly kind: 'sameCurrency' }
  | { readonly kind: 'rate'; readonly rate: FxRate }
  | { readonly kind: 'unavailable' };

export type ReserveDecision =
  | {
      readonly kind: 'accepted';
      readonly reservedMinor: bigint;
      readonly fx: FxRate | null;
    }
  | {
      readonly kind: 'refused';
      readonly code: RefusalCode;
      readonly details?: Record<string, string>;
    };

export function decideReservation(input: {
  readonly program: ProgramPosition;
  readonly invoiceAmountMinor: bigint;
  readonly fx: FxResolution;
}): ReserveDecision {
  const { program, invoiceAmountMinor, fx } = input;

  if (program.positionVerified === false) {
    return { kind: 'refused', code: 'POSITION_UNVERIFIED' };
  }

  if (isOverLimit(program)) {
    return { kind: 'refused', code: 'PROGRAM_OVER_LIMIT' };
  }

  if (fx.kind === 'unavailable') {
    return { kind: 'refused', code: 'FX_RATE_UNAVAILABLE' };
  }

  let reservedMinor: bigint;
  let acceptedFx: FxRate | null;

  if (fx.kind === 'sameCurrency') {
    reservedMinor = invoiceAmountMinor;
    acceptedFx = null;
  } else {
    const converted = convert(
      money(invoiceAmountMinor, program.currency),
      program.currency,
      fx.rate.scaledRate,
    );

    if (converted.kind === 'roundsToZero') {
      return { kind: 'refused', code: 'AMOUNT_ROUNDS_TO_ZERO' };
    }

    reservedMinor = converted.amount.minor;
    acceptedFx = fx.rate;
  }

  const availableMinor = available(program);

  if (reservedMinor > availableMinor) {
    return {
      kind: 'refused',
      code: 'INSUFFICIENT_CAPACITY',
      details: {
        requestedMinor: reservedMinor.toString(),
        availableMinor: availableMinor.toString(),
      },
    };
  }

  return { kind: 'accepted', reservedMinor, fx: acceptedFx };
}
