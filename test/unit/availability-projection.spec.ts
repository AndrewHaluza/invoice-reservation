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
    treasuryAppliedEffectiveAt: null,
    positionChangedAt: new Date('2026-01-01T00:00:00.000Z'),
    investigationRequired: false,
    positionVerified: true,
    ...overrides,
  });
}

describe('toAvailabilityBody', () => {
  it('renders limit, reserved components and signed available as minor-unit strings', () => {
    const body = toAvailabilityBody(program(), false, null);

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
      false,
      null,
    );

    expect(body.available.amountMinor).toBe('-60000');
    expect(body.overLimit.active).toBe(true);
    expect(body.overLimit.since).toBe(since.toISOString());
  });

  it('reports null when the process has observed no message for the program', () => {
    const applied = new Date('2026-01-01T00:00:30.000Z');
    const body = toAvailabilityBody(
      program({ treasuryAppliedEffectiveAt: applied }),
      false,
      null,
    );

    expect(body.treasury.lagSeconds).toBeNull();
  });

  it('reports null when no treasury message has been applied', () => {
    const body = toAvailabilityBody(
      program({ treasuryAppliedEffectiveAt: null }),
      false,
      Date.parse('2026-01-01T00:00:30.000Z'),
    );

    expect(body.treasury.lagSeconds).toBeNull();
  });

  it('reports the whole seconds between the applied effective time and the observed head', () => {
    const applied = new Date('2026-01-01T00:00:00.000Z');
    const body = toAvailabilityBody(
      program({ treasuryAppliedEffectiveAt: applied }),
      false,
      applied.getTime() + 65_000,
    );

    expect(body.treasury.lagSeconds).toBe(65);
  });

  it('floors a partial second', () => {
    const applied = new Date('2026-01-01T00:00:00.000Z');
    const body = toAvailabilityBody(
      program({ treasuryAppliedEffectiveAt: applied }),
      false,
      applied.getTime() + 1_900,
    );

    expect(body.treasury.lagSeconds).toBe(1);
  });

  it('reports zero when the applied effective time is at or ahead of the observed head', () => {
    const applied = new Date('2026-01-01T00:00:00.000Z');
    const body = toAvailabilityBody(
      program({ treasuryAppliedEffectiveAt: applied }),
      false,
      applied.getTime() - 5_000,
    );

    expect(body.treasury.lagSeconds).toBe(0);
  });

  it('carries the reconciliation flag it is given', () => {
    expect(toAvailabilityBody(program(), true, null).reconciliationPending).toBe(
      true,
    );
    expect(toAvailabilityBody(program(), false, null).reconciliationPending).toBe(
      false,
    );
  });

  it('produces every field the Availability schema marks required', () => {
    const body = toAvailabilityBody(program(), false, null) as unknown as Record<
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
