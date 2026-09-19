import { reserveFingerprint } from '../../src/capacity/application/idempotency.service';

describe('reserveFingerprint', () => {
  const base = {
    programId: 'b1b2c3d4-0001-0000-0000-000000000011',
    invoiceId: 'inv-1',
    amountMinor: '100000',
    currency: 'USD',
  };

  it('returns the same digest for identical input', () => {
    expect(reserveFingerprint({ ...base })).toBe(reserveFingerprint({ ...base }));
  });

  it('changes the digest when any one of the four fields changes', () => {
    const changes = [
      { ...base, programId: 'b1b2c3d4-0001-0000-0000-000000000012' },
      { ...base, invoiceId: 'inv-2' },
      { ...base, amountMinor: '100001' },
      { ...base, currency: 'EUR' },
    ];

    for (const changed of changes) {
      expect(reserveFingerprint(changed)).not.toBe(reserveFingerprint(base));
    }
  });

  it('is 64 lowercase hex characters', () => {
    expect(reserveFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
