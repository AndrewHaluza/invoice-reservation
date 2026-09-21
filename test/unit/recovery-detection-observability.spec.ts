import { DataSource } from 'typeorm';
import { RecoveryDetectionService } from '../../src/capacity/application/recovery-detection.service';
import {
  positionUnverifiedPrograms,
  registerMetrics,
  resetMetrics,
} from '../../src/observability/metrics';

interface FixtureRow {
  program_id: string;
  ledger_at: Date | null;
  position_at: Date | null;
}

function serviceWith(rows: ReadonlyArray<FixtureRow>): RecoveryDetectionService {
  const query = jest.fn(async (sql: string) => {
    if (sql.trimStart().startsWith('SELECT')) {
      return rows;
    }
    return [];
  });
  return new RecoveryDetectionService({ query } as unknown as DataSource);
}

describe('RecoveryDetectionService observability', () => {
  beforeEach(() => {
    registerMetrics();
    resetMetrics();
  });

  it('flags and counts two programs behind their ledger', async () => {
    const service = serviceWith([
      {
        program_id: '00000000-0000-4000-8000-000000000001',
        ledger_at: new Date('2026-01-02T00:00:00.000Z'),
        position_at: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        program_id: '00000000-0000-4000-8000-000000000002',
        ledger_at: new Date('2026-01-02T00:00:00.000Z'),
        position_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const report = await service.detect();

    expect(report.flagged).toHaveLength(2);
    const metric = await positionUnverifiedPrograms.get();
    expect(metric.values[0]?.value).toBe(2);
  });

  it('does not flag a current program and reads the gauge at zero', async () => {
    const service = serviceWith([
      {
        program_id: '00000000-0000-4000-8000-000000000003',
        ledger_at: new Date('2026-01-02T00:00:00.000Z'),
        position_at: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);

    const report = await service.detect();

    expect(report.flagged).toEqual([]);
    const metric = await positionUnverifiedPrograms.get();
    expect(metric.values[0]?.value).toBe(0);
  });

  it('skips a program with no treasury ledger entry and reads the gauge at zero', async () => {
    const service = serviceWith([
      {
        program_id: '00000000-0000-4000-8000-000000000004',
        ledger_at: null,
        position_at: null,
      },
    ]);

    const report = await service.detect();

    expect(report.flagged).toEqual([]);
    const metric = await positionUnverifiedPrograms.get();
    expect(metric.values[0]?.value).toBe(0);
  });
});
