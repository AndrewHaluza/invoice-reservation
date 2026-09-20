import {
  ReleaseInput,
  ReservationSnapshot,
  releasePolicy,
} from '../../src/capacity/domain/policies/release.policy';
import { money } from '../../src/shared/money/money';
import {
  RATE_SCALE,
  convert,
  roundHalfUp,
  scaleRate,
} from '../../src/shared/money/convert';

function snapshot(
  overrides: Partial<ReservationSnapshot> = {},
): ReservationSnapshot {
  return {
    invoiceCurrency: 'USD',
    programCurrency: 'USD',
    outstandingInvoiceMinor: 1_000n,
    outstandingReservedMinor: 1_000n,
    status: 'ACTIVE',
    ...overrides,
  };
}

function release(overrides: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    releaseMinor: 100n,
    releaseCurrency: 'USD',
    reservation: snapshot(),
    scaledRate: scaleRate('1.0'),
    ...overrides,
  };
}

describe('releasePolicy', () => {
  it('snaps a full repayment to the reserved remainder even when the conversion rounds off by one', () => {
    const decision = releasePolicy(
      release({
        releaseMinor: 100n,
        reservation: snapshot({
          outstandingInvoiceMinor: 100n,
          outstandingReservedMinor: 110n,
        }),
        // round_half_up(100 * 1.085) === 109, one unit below the reserved remainder.
        scaledRate: scaleRate('1.0850000000'),
      }),
    );

    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.deltaMinor).toBe(110n);
      expect(decision.value.outstandingInvoiceMinor).toBe(0n);
      expect(decision.value.outstandingReservedMinor).toBe(0n);
      expect(decision.value.status).toBe('FULLY_RELEASED');
    }
  });

  it('refuses a release larger than the outstanding invoice instead of driving it negative', () => {
    // At a sub-1 rate 101 units convert to 10, within the reserved remainder of
    // 10; without the invoice bound this would leave outstanding_invoice at -1.
    const decision = releasePolicy(
      release({
        releaseMinor: 101n,
        reservation: snapshot({
          outstandingInvoiceMinor: 100n,
          outstandingReservedMinor: 10n,
        }),
        scaledRate: scaleRate('0.1000000000'),
      }),
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toBe('RELEASE_EXCEEDS_RESERVED');
    }
  });

  it('refuses an inconsistent reservation whose reserved is below its converted invoice', () => {
    // Exercises the `deltaMinor < 0n` branch at release.policy.ts:107-109.
    const decision = releasePolicy(
      release({
        releaseMinor: 101n,
        reservation: snapshot({
          outstandingInvoiceMinor: 1_000n,
          outstandingReservedMinor: 100n,
        }),
      }),
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toBe('RELEASE_EXCEEDS_RESERVED');
    }
  });

  it('refuses a release larger than the outstanding invoice', () => {
    // Exercises the invoice-currency bound at release.policy.ts:70-72.
    const rate = scaleRate('1.0');
    const decision = releasePolicy(
      release({
        releaseMinor: 1_001n,
        reservation: snapshot({
          outstandingInvoiceMinor: 1_000n,
          outstandingReservedMinor: roundHalfUp(1_000n * rate, RATE_SCALE),
        }),
        scaledRate: rate,
      }),
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toBe('RELEASE_EXCEEDS_RESERVED');
    }
  });

  it('keeps outstandingReserved equal to the converted outstanding invoice after a partial release', () => {
    const rate = scaleRate('0.9216589862');
    const decision = releasePolicy(
      release({
        releaseMinor: 400n,
        reservation: snapshot({
          programCurrency: 'EUR',
          outstandingInvoiceMinor: 1_000n,
          outstandingReservedMinor: roundHalfUp(1_000n * rate, RATE_SCALE),
        }),
        scaledRate: rate,
      }),
    );

    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.outstandingInvoiceMinor).toBe(600n);
      const remainder = convert(money(600n, 'EUR'), 'EUR', rate);
      expect(remainder.kind).toBe('converted');
      if (remainder.kind === 'converted') {
        expect(decision.value.outstandingReservedMinor).toBe(
          remainder.amount.minor,
        );
      }
    }
  });

  it('refuses a release whose converted value rounds to zero', () => {
    const decision = releasePolicy(
      release({
        releaseMinor: 1n,
        reservation: snapshot({
          outstandingInvoiceMinor: 5n,
          outstandingReservedMinor: 1n,
        }),
        scaledRate: scaleRate('0.2000000000'),
      }),
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toBe('AMOUNT_ROUNDS_TO_ZERO');
    }
  });

  it('refuses a release that would return no capacity even when the invoice shrinks', () => {
    const decision = releasePolicy(
      release({
        releaseMinor: 1n,
        reservation: snapshot({
          outstandingInvoiceMinor: 2n,
          outstandingReservedMinor: 1n,
        }),
        scaledRate: scaleRate('0.5000000000'),
      }),
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toBe('AMOUNT_ROUNDS_TO_ZERO');
    }
  });

  it('settles a remainder worth less than one minor unit as sub-unit dust', () => {
    const decision = releasePolicy(
      release({
        releaseMinor: 4n,
        reservation: snapshot({
          outstandingInvoiceMinor: 5n,
          outstandingReservedMinor: 1n,
        }),
        scaledRate: scaleRate('0.2000000000'),
      }),
    );

    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.deltaMinor).toBe(1n);
      expect(decision.value.outstandingInvoiceMinor).toBe(0n);
      expect(decision.value.outstandingReservedMinor).toBe(0n);
      expect(decision.value.status).toBe('FULLY_RELEASED');
    }
  });

  it('decreases both outstandings by their respective amounts on a partial release', () => {
    const decision = releasePolicy(
      release({
        releaseMinor: 100n,
        reservation: snapshot({
          outstandingInvoiceMinor: 1_000n,
          outstandingReservedMinor: 250n,
        }),
        scaledRate: scaleRate('0.25'),
      }),
    );

    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.deltaMinor).toBe(25n);
      expect(decision.value.outstandingInvoiceMinor).toBe(900n);
      expect(decision.value.outstandingReservedMinor).toBe(225n);
      expect(decision.value.status).toBe('PARTIALLY_RELEASED');
    }
  });

  it('converts the release at the rate fixed on the reservation', () => {
    const decision = releasePolicy(
      release({
        releaseMinor: 20_000n,
        releaseCurrency: 'EUR',
        reservation: snapshot({
          invoiceCurrency: 'EUR',
          programCurrency: 'USD',
          outstandingInvoiceMinor: 33_333n,
          outstandingReservedMinor: 36_166n,
        }),
        scaledRate: scaleRate('1.0850000000'),
      }),
    );

    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.deltaMinor).toBe(21_700n);
      expect(decision.value.outstandingInvoiceMinor).toBe(13_333n);
      expect(decision.value.outstandingReservedMinor).toBe(14_466n);
      expect(decision.value.status).toBe('PARTIALLY_RELEASED');
    }
  });

  it('does not strand a sub-1-rate reservation short of FULLY_RELEASED', () => {
    const scaledRate = scaleRate('0.9200000000');

    const first = releasePolicy(
      release({
        releaseMinor: 40n,
        reservation: snapshot({
          programCurrency: 'EUR',
          outstandingInvoiceMinor: 100n,
          outstandingReservedMinor: 92n,
        }),
        scaledRate,
      }),
    );

    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.value.deltaMinor).toBe(37n);
    expect(first.value.outstandingInvoiceMinor).toBe(60n);
    expect(first.value.outstandingReservedMinor).toBe(55n);

    const second = releasePolicy(
      release({
        releaseMinor: 60n,
        reservation: snapshot({
          programCurrency: 'EUR',
          outstandingInvoiceMinor: 60n,
          outstandingReservedMinor: 55n,
        }),
        scaledRate,
      }),
    );

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.deltaMinor).toBe(55n);
      expect(second.value.outstandingInvoiceMinor).toBe(0n);
      expect(second.value.outstandingReservedMinor).toBe(0n);
      expect(second.value.status).toBe('FULLY_RELEASED');
    }

    // The capacity returned across both instalments equals what was reserved.
    expect(first.value.deltaMinor + (second.ok ? second.value.deltaMinor : 0n)).toBe(
      92n,
    );
  });

  it('refuses a release denominated in any currency but the invoice currency', () => {
    const decision = releasePolicy(
      release({
        releaseCurrency: 'EUR',
        reservation: snapshot({ invoiceCurrency: 'USD' }),
      }),
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toBe('CURRENCY_MISMATCH');
    }
  });

  it('refuses a zero or negative release amount', () => {
    for (const amount of [0n, -1n]) {
      const decision = releasePolicy(release({ releaseMinor: amount }));

      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.error).toBe('INVALID_AMOUNT');
      }
    }
  });

  it.each(['FULLY_RELEASED', 'CANCELLED', 'WRITTEN_OFF'] as const)(
    'refuses a reservation already in terminal status %s',
    (status) => {
      const decision = releasePolicy(
        release({ reservation: snapshot({ status }) }),
      );

      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.error).toBe('RESERVATION_TERMINAL');
      }
    },
  );

  it('does not mutate the input reservation', () => {
    const reservation = snapshot({
      outstandingInvoiceMinor: 1_000n,
      outstandingReservedMinor: 250n,
    });
    const copy = { ...reservation };

    releasePolicy(release({ reservation }));

    expect(reservation).toEqual(copy);
  });
});
