import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/config/data-source';
import {
  IdempotencyService,
  RequestIdentity,
} from '../../src/capacity/application/idempotency.service';
import { PostgresFixture, startPostgres } from '../support/postgres-container';

jest.setTimeout(180_000);

describe('IdempotencyService', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let service: IdempotencyService;

  let organisationId: string;
  let otherOrganisationId: string;

  const insertReturningId = async (
    sql: string,
    parameters: unknown[],
  ): Promise<string> => {
    const rows = await ds.query<{ id: string }[]>(sql, parameters);
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('expected the insert to return exactly one row');
    }
    return id;
  };

  const identity = (
    requestId: string,
    fingerprint = 'fp-1',
    organisation = organisationId,
  ): RequestIdentity => ({
    organisationId: organisation,
    requestId,
    operation: 'RESERVE',
    fingerprint,
  });

  beforeAll(async () => {
    fixture = await startPostgres();

    ds = new DataSource({
      ...dataSourceOptions,
      url: fixture.ownerUrl,
      entities: [],
    });
    await ds.initialize();
    await ds.runMigrations();

    service = new IdempotencyService();

    organisationId = await insertReturningId(
      `INSERT INTO organisation (name) VALUES ($1) RETURNING id`,
      ['idem-org-a'],
    );
    otherOrganisationId = await insertReturningId(
      `INSERT INTO organisation (name) VALUES ($1) RETURNING id`,
      ['idem-org-b'],
    );

    await ds.query(
      `INSERT INTO program
         (organisation_id, currency, credit_limit_minor, local_reserved_minor)
       VALUES ($1, $2, $3, $4)`,
      [organisationId, 'USD', 1_000_000, 0],
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await fixture?.stop();
  });

  it('proceeds on the first begin, then replays the stored outcome after complete', async () => {
    const key = identity('req-replay');

    await expect(service.begin(ds.manager, key, new Date())).resolves.toEqual({
      kind: 'proceed',
    });

    await service.complete(ds.manager, key, { ok: true, nested: { n: 1 } });

    const decision = await service.begin(ds.manager, key, new Date());

    expect(decision).toEqual({
      kind: 'replay',
      outcome: { ok: true, nested: { n: 1 } },
    });
  });

  it('refuses a differing fingerprint for the same request id', async () => {
    await service.begin(ds.manager, identity('req-conflict', 'fp-a'), new Date());

    const decision = await service.begin(
      ds.manager,
      identity('req-conflict', 'fp-b'),
      new Date(),
    );

    expect(decision).toEqual({ kind: 'refused', code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('refuses a row left PENDING by a committed transaction as REQUEST_IN_FLIGHT', async () => {
    await ds.query(
      `INSERT INTO request_record
         (organisation_id, request_id, operation, content_fingerprint, state)
       VALUES ($1, $2, $3, $4, $5)`,
      [organisationId, 'req-pending', 'RESERVE', 'fp-1', 'PENDING'],
    );

    const decision = await service.begin(
      ds.manager,
      identity('req-pending'),
      new Date(),
    );

    expect(decision).toEqual({ kind: 'refused', code: 'REQUEST_IN_FLIGHT' });
  });

  it('refuses a row set to EXPIRED with a null outcome as IDEMPOTENCY_EXPIRED', async () => {
    await ds.query(
      `INSERT INTO request_record
         (organisation_id, request_id, operation, content_fingerprint, state, outcome)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [organisationId, 'req-expired', 'RESERVE', 'fp-1', 'EXPIRED'],
    );

    const decision = await service.begin(
      ds.manager,
      identity('req-expired'),
      new Date(),
    );

    expect(decision).toEqual({ kind: 'refused', code: 'IDEMPOTENCY_EXPIRED' });
  });

  it('treats the same request id under different organisations as separate rows', async () => {
    const first = await service.begin(
      ds.manager,
      identity('req-shared', 'fp-1', organisationId),
      new Date(),
    );
    const second = await service.begin(
      ds.manager,
      identity('req-shared', 'fp-1', otherOrganisationId),
      new Date(),
    );

    expect(first).toEqual({ kind: 'proceed' });
    expect(second).toEqual({ kind: 'proceed' });
  });
});
