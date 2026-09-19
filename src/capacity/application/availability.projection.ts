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
  readonly overLimit: { readonly active: boolean; readonly since: string | null };
  readonly positionChangedAt: string;
  readonly treasury: {
    readonly appliedVersion: number;
    readonly effectiveAt: string | null;
    readonly lagSeconds: number;
  };
}

export function toAvailabilityBody(
  program: ProgramEntity,
  now: Date,
): AvailabilityBody {
  const totalReservedMinor =
    program.localReservedMinor + program.treasuryReservedMinor;
  const availableMinor = program.creditLimitMinor - totalReservedMinor;

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
    overLimit: {
      active: totalReservedMinor > program.creditLimitMinor,
      since: program.overLimitSince?.toISOString() ?? null,
    },
    positionChangedAt: program.positionChangedAt.toISOString(),
    treasury: {
      appliedVersion: Number(program.treasuryVersion),
      effectiveAt: program.treasuryEffectiveAt?.toISOString() ?? null,
      // This is an interim derivation. The contract defines lag against the newest message
      // available on the stream, and no stream high-water mark is recorded until the Phase 7
      // consumer exists.
      lagSeconds:
        program.treasuryEffectiveAt === null
          ? 0
          : Math.max(
              0,
              (now.getTime() - program.treasuryEffectiveAt.getTime()) / 1000,
            ),
    },
  };
}
