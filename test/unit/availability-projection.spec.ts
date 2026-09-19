import { ProgramEntity } from '../../src/capacity/infrastructure/entities/program.entity';
import { toAvailabilityBody } from '../../src/capacity/application/availability.projection';
import { minorUnitDigits } from '../../src/shared/money';

function program(overrides: Partial<ProgramEntity> = {}): ProgramEntity {
  return Object.assign(new ProgramEntity(), {
    id: 'b1b2c3d4-0001-0000-0000-000000000011',
    organisationId: 'a1b2c3d4-0001-0000-0000-000000000001',
    currency: 'USD',
    creditLimitMinor: 10_000_000_00n,
    localReservedMinor: 1_000_00n,
    treasuryReservedMinor: 2_000_00n,
    nextSequence: 0n,
    overLimitSince: null,
    treasuryVersion: 0n,
    treasuryEffectiveAt: null,
    positionChangedAt: new Date('2026-01-01T00:00:00.000Z'),
    investigationRequired: false,
    positionVerified: true,
    ...overrides,
  });
}

const now = new Date('2026-01-01T00:01:00.000Z');

describe('toAvailabilityBody', () => {
  it('renders limit, reserved components and signed available as minor-unit strings', () => {
    const body = toAvailabilityBody(program(), now);

    expect(body.creditLimit.amountMinor).toBe('1000000000');
    expect(body.reserved.local.amountMinor).toBe('100000');
    expect(body.reserved.treasury.amountMinor).toBe('200000');
    expect(body.reserved.total.amountMinor).toBe('300000');
    expect(body.available.amountMinor).toBe('999700000');
  });

  it('renders a negative available and an active over-limit state', () => {
    const since = new Date('2026-01-01T00:00:00.000Z');
    const body = toAvailabilityBody(
      program({
        creditLimitMinor: 100_000n,
        localReservedMinor: 80_000n,
        treasuryReservedMinor: 80_000n,
        overLimitSince: since,
      }),
      now,
    );

    expect(body.available.amountMinor).toBe('-60000');
    expect(body.overLimit.active).toBe(true);
    expect(body.overLimit.since).toBe(since.toISOString());
  });

  it('derives lagSeconds from the treasury effective time', () => {
    const effectiveAt = new Date('2026-01-01T00:00:30.000Z');
    const body = toAvailabilityBody(
      program({ treasuryEffectiveAt: effectiveAt }),
      now,
    );

    expect(body.treasury.lagSeconds).toBe(30);
    expect(body.treasury.effectiveAt).toBe(effectiveAt.toISOString());
  });

  it('reports zero lag and a null effective time when treasury is unset', () => {
    const body = toAvailabilityBody(
      program({ treasuryEffectiveAt: null }),
      now,
    );

    expect(body.treasury.lagSeconds).toBe(0);
    expect(body.treasury.effectiveAt).toBeNull();
  });

  it('produces every field the Availability schema marks required', () => {
    const body = toAvailabilityBody(program(), now) as unknown as Record<
      string,
      unknown
    >;

    for (const key of [
      'programId',
      'currency',
      'creditLimit',
      'reserved',
      'available',
      'overLimit',
      'positionChangedAt',
      'treasury',
      'positionVerified',
      'investigationRequired',
    ]) {
      expect(body).toHaveProperty(key);
    }
  });
});

describe('minorUnitDigits', () => {
  it('classifies zero, three and two decimal currencies', () => {
    expect(minorUnitDigits('JPY')).toBe(0);
    expect(minorUnitDigits('KWD')).toBe(3);
    expect(minorUnitDigits('USD')).toBe(2);
  });
});
