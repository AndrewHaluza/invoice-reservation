import {
  ProgramPosition,
  available,
  isOverLimit,
  totalReserved,
} from '../domain/program';
import { ProgramEntity } from '../infrastructure/entities/program.entity';

export interface MoneyBody {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface AvailabilityBody {
  readonly programId: string;
  readonly currency: string;
  readonly creditLimit: MoneyBody;
  readonly reserved: {
    readonly total: MoneyBody;
    readonly local: MoneyBody;
    readonly treasury: MoneyBody;
  };
  readonly available: MoneyBody;
  readonly positionVerified: boolean;
  readonly investigationRequired: boolean;
  readonly reconciliationPending: boolean;
  readonly overLimit: { readonly active: boolean; readonly since: string | null };
  readonly positionChangedAt: string;
  readonly treasury: {
    readonly appliedVersion: number;
    readonly effectiveAt: string | null;
    readonly lagSeconds: number | null;
  };
}

export function toAvailabilityBody(
  program: ProgramEntity,
  reconciliationPending: boolean,
  newestObservedEffectiveAtMs: number | null,
): AvailabilityBody {
  const position: ProgramPosition = program;
  const totalReservedMinor = totalReserved(position);
  const availableMinor = available(position);

  const money = (amountMinor: bigint): MoneyBody => ({
    amountMinor: amountMinor.toString(),
    currency: program.currency,
  });

  return {
    programId: program.id,
    currency: program.currency,
    creditLimit: money(program.creditLimitMinor),
    reserved: {
      total: money(totalReservedMinor),
      local: money(program.localReservedMinor),
      treasury: money(program.treasuryReservedMinor),
    },
    available: money(availableMinor),
    positionVerified: program.positionVerified,
    investigationRequired: program.investigationRequired,
    reconciliationPending,
    overLimit: {
      active: isOverLimit(position),
      since: program.overLimitSince?.toISOString() ?? null,
    },
    positionChangedAt: program.positionChangedAt.toISOString(),
    treasury: {
      appliedVersion: Number(program.treasuryVersion),
      effectiveAt: program.treasuryEffectiveAt?.toISOString() ?? null,
      lagSeconds: lagSecondsFor(
        program.treasuryAppliedEffectiveAt,
        newestObservedEffectiveAtMs,
      ),
    },
  };
}

// FR-007a: the distance between the newest treasury message applied to this
// program and the newest one seen for it on the stream. Both operands are
// business effective times from the message payload, so the difference is
// meaningful and is zero for a caught-up program. Note this uses
// treasuryAppliedEffectiveAt, which both apply paths advance — not
// treasuryEffectiveAt, which only snapshots advance. Null means not knowable:
// no treasury message has been applied, or this process has observed none for
// the program. Null is never the same as zero.
function lagSecondsFor(
  appliedEffectiveAt: Date | null,
  newestObservedEffectiveAtMs: number | null,
): number | null {
  if (appliedEffectiveAt === null || newestObservedEffectiveAtMs === null) {
    return null;
  }
  const deltaMs = newestObservedEffectiveAtMs - appliedEffectiveAt.getTime();
  return deltaMs <= 0 ? 0 : Math.floor(deltaMs / 1000);
}
