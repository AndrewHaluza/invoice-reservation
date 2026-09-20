import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cancelPolicy } from '../../src/capacity/domain/policies/cancel.policy';
import {
  ReservationSnapshot,
  releasePolicy,
} from '../../src/capacity/domain/policies/release.policy';
import { scaleRate } from '../../src/shared/money';

const SRC = join(__dirname, '..', '..', 'src');

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function offendingLines(predicate: (line: string) => boolean): string[] {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const relative = file.slice(SRC.length + 1);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (predicate(line)) {
        offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  return offenders;
}

function snapshot(
  overrides: Partial<ReservationSnapshot> = {},
): ReservationSnapshot {
  return {
    invoiceCurrency: 'USD',
    programCurrency: 'USD',
    outstandingInvoiceMinor: 100_000n,
    outstandingReservedMinor: 100_000n,
    status: 'ACTIVE',
    ...overrides,
  };
}

describe('no auto-expiry (FR-028)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs no scheduled job or timer anywhere in src', () => {
    expect(
      offendingLines((line) => /setTimeout|setInterval/.test(line)),
    ).toEqual([]);
    expect(
      offendingLines((line) =>
        /@Cron|@Interval|@Timeout|ScheduleModule/.test(line),
      ),
    ).toEqual([]);
  });

  it('has no TTL or expiry configuration mentioning a reservation', () => {
    expect(
      offendingLines(
        (line) =>
          /invoice_reservation|reservation/i.test(line) &&
          /\bttl\b|expir/i.test(line),
      ),
    ).toEqual([]);
  });

  it('returns the identical decision whatever the wall clock says', () => {
    const confirmedLongAgo = new Date('2000-01-01T00:00:00.000Z');
    const farFuture = new Date('2999-01-01T00:00:00.000Z');

    const releaseAt = (now: Date) => {
      jest.useFakeTimers().setSystemTime(now);
      return releasePolicy({
        releaseMinor: 40_000n,
        releaseCurrency: 'USD',
        reservation: snapshot(),
        scaledRate: scaleRate('1.0'),
      });
    };

    const cancelAt = (now: Date) => {
      jest.useFakeTimers().setSystemTime(now);
      return cancelPolicy(snapshot());
    };

    expect(releaseAt(farFuture)).toEqual(releaseAt(confirmedLongAgo));
    expect(cancelAt(farFuture)).toEqual(cancelAt(confirmedLongAgo));

    const release = releaseAt(confirmedLongAgo);
    expect(release.ok).toBe(true);
    if (release.ok) {
      expect(release.value.status).toBe('PARTIALLY_RELEASED');
      expect(release.value.outstandingReservedMinor).toBe(60_000n);
    }

    const cancel = cancelAt(confirmedLongAgo);
    expect(cancel.ok).toBe(true);
    if (cancel.ok) {
      expect(cancel.value.status).toBe('CANCELLED');
      expect(cancel.value.deltaMinor).toBe(100_000n);
    }
  });
});
