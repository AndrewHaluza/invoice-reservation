import { cancelPolicy } from '../../src/capacity/domain/policies/cancel.policy';
import {
  ReservationSnapshot,
  ReservationStatus,
} from '../../src/capacity/domain/policies/release.policy';

function snapshot(
  overrides: Partial<ReservationSnapshot> = {},
): ReservationSnapshot {
  return {
    invoiceCurrency: 'EUR',
    programCurrency: 'USD',
    outstandingInvoiceMinor: 33_333n,
    outstandingReservedMinor: 36_166n,
    status: 'ACTIVE',
    ...overrides,
  };
}

describe('cancelPolicy', () => {
  it('cancels an ACTIVE reservation with cause CANCELLATION and returns the whole reserved remainder', () => {
    const decision = cancelPolicy(snapshot({ status: 'ACTIVE' }));

    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.deltaMinor).toBe(36_166n);
      expect(decision.value.cause).toBe('CANCELLATION');
      expect(decision.value.status).toBe('CANCELLED');
    }
  });

  it('writes off a PARTIALLY_RELEASED reservation, returning only what remains reserved', () => {
    const decision = cancelPolicy(
      snapshot({
        status: 'PARTIALLY_RELEASED',
        outstandingInvoiceMinor: 13_333n,
        outstandingReservedMinor: 14_466n,
      }),
    );

    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.deltaMinor).toBe(14_466n);
      expect(decision.value.cause).toBe('WRITE_OFF');
      expect(decision.value.status).toBe('WRITTEN_OFF');
    }
  });

  it('states the returned capacity as a positive magnitude for the service to negate', () => {
    const decision = cancelPolicy(snapshot());

    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.deltaMinor > 0n).toBe(true);
    }
  });

  it.each(['FULLY_RELEASED', 'CANCELLED', 'WRITTEN_OFF'] as const)(
    'refuses a reservation already in terminal status %s',
    (status: ReservationStatus) => {
      const decision = cancelPolicy(snapshot({ status }));

      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.error).toBe('RESERVATION_TERMINAL');
      }
    },
  );

  it('does not mutate the input reservation', () => {
    const reservation = snapshot({ status: 'PARTIALLY_RELEASED' });
    const copy = { ...reservation };

    cancelPolicy(reservation);

    expect(reservation).toEqual(copy);
  });
});
