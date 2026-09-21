import type {
  AvailabilityResponseMirrorsBody,
  CancelResponseMirrorsBody,
  LedgerEntryResponseMirrorsBody,
  ReleaseResponseMirrorsBody,
  ReservationResponseMirrorsBody,
  ReserveResponseMirrorsBody,
} from '../../src/capacity/api/response';

describe('response schema mirrors', () => {
  it('mirrors AvailabilityBody', () => {
    const availabilityMirrors: AvailabilityResponseMirrorsBody = true;
    expect(availabilityMirrors).toBe(true);
  });

  it('mirrors ReservationBody', () => {
    const reservationMirrors: ReservationResponseMirrorsBody = true;
    expect(reservationMirrors).toBe(true);
  });

  it('mirrors ReserveBody', () => {
    const reserveMirrors: ReserveResponseMirrorsBody = true;
    expect(reserveMirrors).toBe(true);
  });

  it('mirrors ReleaseBody', () => {
    const releaseMirrors: ReleaseResponseMirrorsBody = true;
    expect(releaseMirrors).toBe(true);
  });

  it('mirrors CancelBody', () => {
    const cancelMirrors: CancelResponseMirrorsBody = true;
    expect(cancelMirrors).toBe(true);
  });

  it('mirrors LedgerEntryBody', () => {
    const ledgerEntryMirrors: LedgerEntryResponseMirrorsBody = true;
    expect(ledgerEntryMirrors).toBe(true);
  });
});
