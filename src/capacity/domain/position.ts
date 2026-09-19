import {
  PendingLedgerEntry,
  SequencedLedgerEntry,
} from './ledger-entry';
import { ProgramPosition } from './program';

export interface AdvanceResult {
  readonly program: ProgramPosition;
  readonly entries: readonly SequencedLedgerEntry[];
}

export function advancePosition(
  program: ProgramPosition,
  entries: readonly PendingLedgerEntry[],
  now: Date,
): AdvanceResult {
  let localReservedMinor = program.localReservedMinor;
  let treasuryReservedMinor = program.treasuryReservedMinor;
  let creditLimitMinor = program.creditLimitMinor;
  let nextSequence = program.nextSequence;

  const sequenced: SequencedLedgerEntry[] = [];

  for (const pending of entries) {
    const sequence = nextSequence;
    nextSequence = nextSequence + 1n;

    switch (pending.component) {
      case 'LOCAL':
        localReservedMinor = localReservedMinor + pending.deltaMinor;
        break;
      case 'TREASURY':
        treasuryReservedMinor = treasuryReservedMinor + pending.deltaMinor;
        break;
      case 'LIMIT':
        creditLimitMinor = creditLimitMinor + pending.deltaMinor;
        break;
    }

    sequenced.push({ ...pending, sequence });
  }

  const wasOverLimit = program.overLimitSince !== null;
  const nowOverLimit =
    localReservedMinor + treasuryReservedMinor > creditLimitMinor;

  const lastEntry =
    entries.length > 0 ? entries[entries.length - 1] : undefined;
  const correlationId = lastEntry === undefined ? 'system' : lastEntry.correlationId;

  let overLimitSince = program.overLimitSince;

  if (!wasOverLimit && nowOverLimit) {
    sequenced.push({
      deltaMinor: 0n,
      component: 'LIMIT',
      cause: 'OVER_LIMIT_ONSET',
      originReference: null,
      actor: 'system',
      correlationId,
      sequence: nextSequence,
    });
    nextSequence = nextSequence + 1n;
    overLimitSince = now;
  } else if (wasOverLimit && !nowOverLimit) {
    sequenced.push({
      deltaMinor: 0n,
      component: 'LIMIT',
      cause: 'OVER_LIMIT_CLEARED',
      originReference: null,
      actor: 'system',
      correlationId,
      sequence: nextSequence,
    });
    nextSequence = nextSequence + 1n;
    overLimitSince = null;
  }

  return {
    program: {
      ...program,
      creditLimitMinor,
      localReservedMinor,
      treasuryReservedMinor,
      nextSequence,
      overLimitSince,
    },
    entries: sequenced,
  };
}
