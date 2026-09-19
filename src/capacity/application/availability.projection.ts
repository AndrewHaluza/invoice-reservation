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
      // The contract defines lag against the newest message available on the
      // stream (FR-007a). No stream head is recorded until the phase 7 consumer
      // exists, so the figure is not knowable: null, never a fabricated zero.
      lagSeconds: null,
    },
  };
}
