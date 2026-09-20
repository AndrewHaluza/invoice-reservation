import { ConfigService } from '@nestjs/config';
import { ApplySnapshotService } from '../../src/capacity/application/apply-snapshot.service';

interface GuardAccess {
  exceedsMagnitudeGuard(
    deltaTreasury: bigint,
    creditLimitMinor: bigint,
  ): boolean;
}

function serviceWithRatio(ratio: number): GuardAccess {
  const config = {
    get: (key: string): unknown =>
      key === 'SNAPSHOT_DELTA_GUARD_RATIO' ? ratio : undefined,
  } as unknown as ConfigService;

  const service = new ApplySnapshotService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    config,
  );

  return service as unknown as GuardAccess;
}

describe('ApplySnapshotService.exceedsMagnitudeGuard', () => {
  it('quarantines a treasury delta above the guard ratio', () => {
    expect(serviceWithRatio(0.5).exceedsMagnitudeGuard(501n, 1000n)).toBe(true);
  });

  it('admits a treasury delta exactly at the guard ratio', () => {
    expect(serviceWithRatio(0.5).exceedsMagnitudeGuard(500n, 1000n)).toBe(
      false,
    );
  });

  it('is exact for a credit limit above 2^53', () => {
    expect(
      serviceWithRatio(0.5).exceedsMagnitudeGuard(
        4_503_599_627_370_497n,
        9_007_199_254_740_993n,
      ),
    ).toBe(true);
  });
});
