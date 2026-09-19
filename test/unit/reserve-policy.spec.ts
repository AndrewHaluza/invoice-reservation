import { ProgramPosition } from '../../src/capacity/domain/program';
import { FxRate } from '../../src/capacity/domain/ports/fx-rate.provider';
import {
  FxResolution,
  decideReservation,
} from '../../src/capacity/domain/policies/reserve.policy';
import { scaleRate } from '../../src/shared/money';

function program(overrides: Partial<ProgramPosition> = {}): ProgramPosition {
  return {
    id: 'program-1',
    currency: 'USD',
    creditLimitMinor: 1_000_000n,
    localReservedMinor: 0n,
    treasuryReservedMinor: 0n,
    nextSequence: 1n,
    overLimitSince: null,
    investigationRequired: false,
    positionVerified: true,
    ...overrides,
  };
}

function rate(scaled: bigint, value: string): FxRate {
  return {
    scaledRate: scaled,
    rate: value,
    effectiveAt: new Date(0),
    source: 'test',
  };
}

describe('decideReservation', () => {
  it('refuses an unverified program even with ample capacity', () => {
    const decision = decideReservation({
      program: program({ positionVerified: false }),
      invoiceAmountMinor: 100n,
      fx: { kind: 'sameCurrency' },
    });

    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe('POSITION_UNVERIFIED');
    }
  });

  it('lets POSITION_UNVERIFIED win over PROGRAM_OVER_LIMIT', () => {
    const decision = decideReservation({
      program: program({
        positionVerified: false,
        creditLimitMinor: 1_000n,
        localReservedMinor: 1_200n,
      }),
      invoiceAmountMinor: 100n,
      fx: { kind: 'sameCurrency' },
    });

    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe('POSITION_UNVERIFIED');
    }
  });

  it('refuses a verified over-limit program with nominal room', () => {
    const decision = decideReservation({
      program: program({
        creditLimitMinor: 1_000n,
        localReservedMinor: 1_200n,
      }),
      invoiceAmountMinor: 1n,
      fx: { kind: 'sameCurrency' },
    });

    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe('PROGRAM_OVER_LIMIT');
    }
  });

  it('refuses when the FX rate is unavailable', () => {
    const decision = decideReservation({
      program: program(),
      invoiceAmountMinor: 100n,
      fx: { kind: 'unavailable' },
    });

    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe('FX_RATE_UNAVAILABLE');
    }
  });

  it('refuses an amount that rounds to zero', () => {
    const fx: FxResolution = {
      kind: 'rate',
      rate: rate(scaleRate('0.0067'), '0.0067'),
    };

    const decision = decideReservation({
      program: program(),
      invoiceAmountMinor: 1n,
      fx,
    });

    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe('AMOUNT_ROUNDS_TO_ZERO');
    }
  });

  it('refuses a request one minor unit above available, with details', () => {
    const decision = decideReservation({
      program: program({ creditLimitMinor: 1_000n, localReservedMinor: 0n }),
      invoiceAmountMinor: 1_001n,
      fx: { kind: 'sameCurrency' },
    });

    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe('INSUFFICIENT_CAPACITY');
      expect(decision.details).toEqual({
        requestedMinor: '1001',
        availableMinor: '1000',
      });
    }
  });

  it('accepts a request exactly equal to available', () => {
    const decision = decideReservation({
      program: program({ creditLimitMinor: 1_000n, localReservedMinor: 0n }),
      invoiceAmountMinor: 1_000n,
      fx: { kind: 'sameCurrency' },
    });

    expect(decision.kind).toBe('accepted');
    if (decision.kind === 'accepted') {
      expect(decision.reservedMinor).toBe(1_000n);
      expect(decision.fx).toBeNull();
    }
  });

  it('converts a cross-currency amount and returns the same FxRate object', () => {
    const fx: FxResolution = {
      kind: 'rate',
      rate: rate(scaleRate('1.0850000000'), '1.0850000000'),
    };

    const decision = decideReservation({
      program: program({ creditLimitMinor: 10_000_000_00n }),
      invoiceAmountMinor: 1_000_000_00n,
      fx,
    });

    expect(decision.kind).toBe('accepted');
    if (decision.kind === 'accepted') {
      expect(decision.reservedMinor).toBe(108_500_000n);
      expect(decision.fx).toBe(fx.rate);
    }
  });

  it('does not mutate the input program', () => {
    const input = program({ creditLimitMinor: 1_000n, localReservedMinor: 100n });
    const copy = { ...input };

    decideReservation({
      program: input,
      invoiceAmountMinor: 100n,
      fx: { kind: 'sameCurrency' },
    });

    expect(input).toEqual(copy);
  });
});
