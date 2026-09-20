import { Injectable } from '@nestjs/common';

@Injectable()
export class StreamLagRegistry {
  private readonly observed = new Map<string, number>();

  observe(programId: string, effectiveAtMs: number): void {
    if (programId.length === 0) {
      return;
    }
    if (!Number.isFinite(effectiveAtMs) || effectiveAtMs <= 0) {
      return;
    }
    const current = this.observed.get(programId);
    if (current === undefined || effectiveAtMs > current) {
      this.observed.set(programId, effectiveAtMs);
    }
  }

  newestObservedFor(programId: string): number | null {
    return this.observed.get(programId) ?? null;
  }
}
