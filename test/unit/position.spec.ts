import {
  PendingLedgerEntry,
  PositionComponent,
  LedgerCause,
} from '../../src/capacity/domain/ledger-entry';
import {
  ProgramPosition,
  available,
  isOverLimit,
  totalReserved,
} from '../../src/capacity/domain/program';
import { advancePosition } from '../../src/capacity/domain/position';

function program(overrides: Partial<ProgramPosition> = {}): ProgramPosition {
  return {
    id: 'program-1',
    currency: 'USD',
    creditLimitMinor: 0n,
    localReservedMinor: 0n,
    treasuryReservedMinor: 0n,
    nextSequence: 1n,
    overLimitSince: null,
    investigationRequired: false,
    positionVerified: true,
    ...overrides,
  };
}

function entry(
  component: PositionComponent,
  deltaMinor: bigint,
  cause: LedgerCause = 'RESERVATION',
): PendingLedgerEntry {
  return {
    deltaMinor,
    component,
    cause,
    originReference: null,
    actor: 'tester',
    correlationId: 'corr-1',
  };
}

const NOW = new Date('2026-09-19T12:00:00Z');
const LATER = new Date('2026-09-19T13:00:00Z');

describe('advancePosition', () => {
  it('advances each component cache by the sum of its entries', () => {
    const result = advancePosition(
      program(),
      [
        entry('LOCAL', 100n),
        entry('TREASURY', 50n),
        entry('LIMIT', 1000n),
        entry('LOCAL', -30n),
      ],
      NOW,
    );

    expect(result.program.localReservedMinor).toBe(70n);
    expect(result.program.treasuryReservedMinor).toBe(50n);
    expect(result.program.creditLimitMinor).toBe(1000n);
  });

  it('assigns gapless sequences starting from nextSequence', () => {
    const result = advancePosition(
      program({ nextSequence: 7n, creditLimitMinor: 1000n }),
      [entry('LOCAL', 1n), entry('LOCAL', 2n), entry('LOCAL', 3n)],
      NOW,
    );

    expect(result.entries.map((e) => e.sequence)).toEqual([7n, 8n, 9n]);
    expect(result.program.nextSequence).toBe(10n);
  });

  it('does not mutate the input program and returns a new object', () => {
    const input = program({ creditLimitMinor: 1000n });
    const copy = { ...input };

    const result = advancePosition(input, [entry('LOCAL', 100n)], NOW);

    expect(input).toEqual(copy);
    expect(result.program).not.toBe(input);
  });

  it('sets the over-limit mark and emits OVER_LIMIT_ONSET on onset', () => {
    const result = advancePosition(
      program({ creditLimitMinor: 1000n }),
      [entry('LOCAL', 1200n)],
      NOW,
    );

    expect(result.program.overLimitSince).toEqual(NOW);

    const marker = result.entries[result.entries.length - 1];
    expect(marker?.cause).toBe('OVER_LIMIT_ONSET');
    expect(marker?.component).toBe('LIMIT');
    expect(marker?.deltaMinor).toBe(0n);
  });

  it('clears the mark by release and emits OVER_LIMIT_CLEARED', () => {
    const over = advancePosition(
      program({ creditLimitMinor: 1000n }),
      [entry('LOCAL', 1200n)],
      NOW,
    );

    const result = advancePosition(
      over.program,
      [entry('LOCAL', -300n, 'RELEASE')],
      LATER,
    );

    expect(result.program.overLimitSince).toBeNull();

    const marker = result.entries[result.entries.length - 1];
    expect(marker?.cause).toBe('OVER_LIMIT_CLEARED');
    expect(marker?.component).toBe('LIMIT');
    expect(marker?.deltaMinor).toBe(0n);
  });

  it('clears the mark via a CANCELLATION negative LOCAL entry', () => {
    const over = advancePosition(
      program({ creditLimitMinor: 1000n }),
      [entry('LOCAL', 1200n)],
      NOW,
    );

    const result = advancePosition(
      over.program,
      [entry('LOCAL', -300n, 'CANCELLATION')],
      LATER,
    );

    expect(result.program.overLimitSince).toBeNull();
    expect(result.entries[result.entries.length - 1]?.cause).toBe(
      'OVER_LIMIT_CLEARED',
    );
  });

  it('clears the mark when the limit is increased', () => {
    const over = advancePosition(
      program({ creditLimitMinor: 1000n }),
      [entry('LOCAL', 1200n)],
      NOW,
    );

    const result = advancePosition(
      over.program,
      [entry('LIMIT', 500n, 'LIMIT_CHANGE')],
      LATER,
    );

    expect(result.program.creditLimitMinor).toBe(1500n);
    expect(result.program.overLimitSince).toBeNull();
    expect(result.entries[result.entries.length - 1]?.cause).toBe(
      'OVER_LIMIT_CLEARED',
    );
  });

  it('causes onset when the limit is reduced below the reserved total', () => {
    const result = advancePosition(
      program({ creditLimitMinor: 1000n, localReservedMinor: 800n }),
      [entry('LIMIT', -500n, 'LIMIT_CHANGE')],
      NOW,
    );

    expect(result.program.creditLimitMinor).toBe(500n);
    expect(result.program.overLimitSince).toEqual(NOW);
    expect(result.entries[result.entries.length - 1]?.cause).toBe(
      'OVER_LIMIT_ONSET',
    );
  });

  it('emits no marker when the mark does not change', () => {
    const result = advancePosition(
      program({ creditLimitMinor: 1000n }),
      [entry('LOCAL', 10n)],
      NOW,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.cause).toBe('RESERVATION');
    expect(result.program.overLimitSince).toBeNull();
  });

  it('stays over limit without a second onset and keeps the original mark', () => {
    const over = advancePosition(
      program({ creditLimitMinor: 1000n }),
      [entry('LOCAL', 1200n)],
      NOW,
    );

    const result = advancePosition(
      over.program,
      [entry('LOCAL', 10n)],
      LATER,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.cause).toBe('RESERVATION');
    expect(result.program.overLimitSince).toEqual(NOW);
  });

  it('treats an empty batch as a no-op', () => {
    const input = program({
      creditLimitMinor: 1000n,
      localReservedMinor: 200n,
      nextSequence: 5n,
    });

    const result = advancePosition(input, [], NOW);

    expect(result.program).toEqual(input);
    expect(result.entries).toHaveLength(0);
  });

  it('accepts treasury reservations that push the total over the limit', () => {
    const result = advancePosition(
      program({ creditLimitMinor: 1000n }),
      [entry('TREASURY', 1500n)],
      NOW,
    );

    expect(result.program.treasuryReservedMinor).toBe(1500n);
    expect(result.program.overLimitSince).toEqual(NOW);
    expect(result.entries[result.entries.length - 1]?.cause).toBe(
      'OVER_LIMIT_ONSET',
    );
  });

  it('evaluates the mark once on the final state within a single batch', () => {
    const result = advancePosition(
      program({ creditLimitMinor: 1000n }),
      [entry('LOCAL', 1200n), entry('LOCAL', -300n)],
      NOW,
    );

    expect(result.entries).toHaveLength(2);
    expect(result.program.localReservedMinor).toBe(900n);
    expect(result.program.overLimitSince).toBeNull();
    expect(result.entries.some((e) => e.cause === 'OVER_LIMIT_ONSET')).toBe(
      false,
    );
    expect(result.entries.some((e) => e.cause === 'OVER_LIMIT_CLEARED')).toBe(
      false,
    );
  });

  it('emits no marker for an empty batch on an already over-limit program', () => {
    const markTime = new Date('2026-09-19T11:00:00Z');
    const input = program({
      creditLimitMinor: 1000n,
      localReservedMinor: 1200n,
      overLimitSince: markTime,
    });

    const result = advancePosition(input, [], NOW);

    expect(result.entries).toHaveLength(0);
    expect(result.program.overLimitSince).toEqual(markTime);
  });

  it('accounts for marker entries in nextSequence', () => {
    const result = advancePosition(
      program({ creditLimitMinor: 1000n, nextSequence: 1n }),
      [entry('LOCAL', 1200n)],
      NOW,
    );

    expect(result.entries.map((e) => e.sequence)).toEqual([1n, 2n]);
    expect(result.program.nextSequence).toBe(3n);
  });

  it('copies the correlationId of the last input entry onto the marker', () => {
    const first: PendingLedgerEntry = {
      ...entry('LOCAL', 1200n),
      correlationId: 'first',
    };
    const last: PendingLedgerEntry = {
      ...entry('LOCAL', 0n),
      correlationId: 'last',
    };

    const result = advancePosition(
      program({ creditLimitMinor: 1000n }),
      [first, last],
      NOW,
    );

    expect(result.entries[result.entries.length - 1]?.correlationId).toBe('last');
  });

  it('uses a system correlationId when an unmarked program is already over limit', () => {
    const result = advancePosition(
      program({
        creditLimitMinor: 1000n,
        localReservedMinor: 1200n,
        overLimitSince: null,
      }),
      [],
      NOW,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.cause).toBe('OVER_LIMIT_ONSET');
    expect(result.entries[0]?.correlationId).toBe('system');
    expect(result.program.overLimitSince).toEqual(NOW);
  });
});

describe('program position helpers', () => {
  it('sums local and treasury into totalReserved', () => {
    expect(
      totalReserved(
        program({ localReservedMinor: 70n, treasuryReservedMinor: 50n }),
      ),
    ).toBe(120n);
  });

  it('returns a signed available that is never floored', () => {
    expect(
      available(program({ creditLimitMinor: 1000n, localReservedMinor: 1200n })),
    ).toBe(-200n);
  });

  it('reports over-limit strictly when the total exceeds the limit', () => {
    expect(
      isOverLimit(program({ creditLimitMinor: 1000n, localReservedMinor: 1000n })),
    ).toBe(false);
    expect(
      isOverLimit(program({ creditLimitMinor: 1000n, localReservedMinor: 1001n })),
    ).toBe(true);
  });
});
