import { DataSource } from 'typeorm';
import { ReconciliationCheckService } from '../../src/capacity/application/reconciliation-check.service';
import {
  investigationRequiredPrograms,
  resetMetrics,
} from '../../src/observability/metrics';

const POSITION_COLUMN_ASSIGNMENT =
  /(local_reserved_minor|treasury_reserved_minor|credit_limit_minor|next_sequence|over_limit_since|treasury_version|treasury_effective_at|position_changed_at)\s*=/i;

function serviceWith(query: jest.Mock): ReconciliationCheckService {
  return new ReconciliationCheckService({ query } as unknown as DataSource);
}

function executedSql(query: jest.Mock): string[] {
  return query.mock.calls.map((call) => String(call[0]));
}

describe('ReconciliationCheckService', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('flags a mismatched program and writes no position column', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          program_id: '00000000-0000-4000-8000-000000000001',
          local_reserved_minor: '1000',
          active_outstanding: '900',
        },
      ])
      .mockResolvedValue([]);
    const service = serviceWith(query);

    const report = await service.check();

    expect(report.programsChecked).toBe(1);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]?.programId).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(report.mismatches[0]?.expected).toBe(900n);
    expect(report.mismatches[0]?.actual).toBe(1000n);

    const sql = executedSql(query);
    expect(
      sql.some((statement) =>
        /UPDATE program[\s\S]*investigation_required\s*=\s*TRUE/i.test(
          statement,
        ),
      ),
    ).toBe(true);
    for (const statement of sql) {
      expect(statement).not.toMatch(POSITION_COLUMN_ASSIGNMENT);
    }

    const metric = await investigationRequiredPrograms.get();
    expect(metric.values[0]?.value).toBe(1);
  });

  it('writes nothing and reports zero when every program reconciles', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        program_id: '00000000-0000-4000-8000-000000000002',
        local_reserved_minor: '500',
        active_outstanding: '500',
      },
    ]);
    const service = serviceWith(query);

    const report = await service.check();

    expect(report.programsChecked).toBe(1);
    expect(report.mismatches).toEqual([]);
    expect(executedSql(query).some((sql) => /UPDATE/i.test(sql))).toBe(false);

    const metric = await investigationRequiredPrograms.get();
    expect(metric.values[0]?.value).toBe(0);
  });
});
