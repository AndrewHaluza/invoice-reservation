export interface ProgramPosition {
  readonly id: string;
  readonly currency: string;
  readonly creditLimitMinor: bigint;
  readonly localReservedMinor: bigint;
  readonly treasuryReservedMinor: bigint;
  readonly nextSequence: bigint;
  readonly overLimitSince: Date | null;
  readonly investigationRequired: boolean;
  readonly positionVerified: boolean;
}

export function totalReserved(p: ProgramPosition): bigint {
  return p.localReservedMinor + p.treasuryReservedMinor;
}

export function available(p: ProgramPosition): bigint {
  return p.creditLimitMinor - totalReserved(p);
}

export function isOverLimit(p: ProgramPosition): boolean {
  return totalReserved(p) > p.creditLimitMinor;
}
