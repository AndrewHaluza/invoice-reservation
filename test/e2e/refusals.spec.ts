/**
 * The fourteenth refusal code, `INVALID_AMOUNT`, is unreachable over HTTP and is
 * therefore not asserted here. `releasePolicy` raises it for a non-positive
 * release amount, but `CreateReleaseDto.amount` is a `PositiveMoneyDto` whose
 * `amountMinor` carries `@Matches(/^[1-9][0-9]{0,18}$/)`, so the global
 * `ValidationPipe` returns `400 VALIDATION_FAILED` before the domain guard runs
 * (R-010). SC-006 asks a reviewer to name both unreachable cases from the suite
 * alone; the other one — the multi-program deadlock — is recorded at the head
 * of `test/e2e/contention.spec.ts`.
 */
import { createHash } from 'node:crypto';
import request from 'supertest';
import type { E2eApp } from '../support/e2e-app';
import {
  startE2eApp,
  stopE2eApp,
  tokenFor,
  WRITE_SCOPE,
} from '../support/e2e-app';
import {
  buildTreasuryHarness,
  insertOrganisation,
  insertProgram,
  snapshotMessage,
} from '../support/treasury';

jest.setTimeout(300_000);

interface ProgramRow {
  credit_limit_minor: string;
  local_reserved_minor: string;
  treasury_reserved_minor: string;
}

describe('capacity refusals over HTTP', () => {
  let fixture: E2eApp;

  beforeAll(async () => {
    fixture = await startE2eApp();
  });

  afterAll(async () => {
    await stopE2eApp(fixture);
  });

  const postReservation = (
    programId: string,
    token: string,
    idempotencyKey: string,
    body: object,
  ) =>
    request(fixture.app.getHttpServer())
      .post(`/v1/programs/${programId}/reservations`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);

  const readProgram = async (programId: string): Promise<ProgramRow> => {
    const rows = await fixture.owner.query<ProgramRow[]>(
      `SELECT credit_limit_minor, local_reserved_minor, treasury_reserved_minor
         FROM program WHERE id = $1`,
      [programId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('expected the program row to exist');
    }
    return row;
  };

  const FORBIDDEN_BODY_KEYS = new Set(['stack', 'sql', 'query']);

  const collectLeakedKeys = (value: unknown, path = '$'): string[] => {
    if (Array.isArray(value)) {
      return value.flatMap((item, index) =>
        collectLeakedKeys(item, `${path}[${index}]`),
      );
    }
    if (typeof value !== 'object' || value === null) {
      return [];
    }
    const leaked: string[] = [];
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_BODY_KEYS.has(key)) {
        leaked.push(`${path}.${key}`);
      }
      leaked.push(...collectLeakedKeys(child, `${path}.${key}`));
    }
    return leaked;
  };

  /**
   * Contract F-5.5: a response body asserted by this suite never carries a
   * `stack`, `sql` or `query` key at any depth.
   */
  const expectNoLeakedInternals = (body: unknown): void => {
    expect(collectLeakedKeys(body)).toEqual([]);
  };

  /**
   * The reserve fingerprint is recomputed here rather than imported (Key
   * Decision 6): the field order is exactly
   * `programId|invoiceId|amountMinor|currency`, with the amount as sent.
   */
  const reserveFingerprintFor = (
    programId: string,
    invoiceId: string,
    amountMinor: string,
    currency: string,
  ): string =>
    createHash('sha256')
      .update(`${programId}|${invoiceId}|${amountMinor}|${currency}`)
      .digest('hex');

  /**
   * Contract F-4 steps 1-4: a fresh program, a local half built over HTTP, a
   * treasury snapshot that tips it over the limit, and the precondition
   * asserted from the program row. The handler call is setup only; no HTTP
   * route can produce an over-limit position.
   */
  const reachOverLimit = async (
    organisationName: string,
    seedInvoiceId: string,
    seedIdempotencyKey: string,
  ) => {
    const organisationId = await insertOrganisation(
      fixture.owner,
      organisationName,
    );
    const programId = await insertProgram(fixture.owner, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });
    const token = tokenFor(organisationId, WRITE_SCOPE);

    const seeded = await postReservation(programId, token, seedIdempotencyKey, {
      invoiceId: seedInvoiceId,
      amount: { amountMinor: '900000', currency: 'USD' },
    });
    expect(seeded.status).toBe(201);

    const harness = buildTreasuryHarness(fixture.owner);
    await harness.snapshotHandler.handle(
      snapshotMessage({
        programId,
        version: 1,
        currency: 'USD',
        creditLimitMinor: '1000000',
        reservedMinor: '400000',
      }),
    );

    // The precondition is not decoration: if the snapshot were quarantined —
    // by the delta guard, a stale version or a missing acknowledgement marker —
    // the program would still be within its limit and the next reservation
    // would return 201, blaming the refusal logic for a fixture defect.
    const row = await readProgram(programId);
    expect(row.local_reserved_minor).toBe('900000');
    expect(row.treasury_reserved_minor).toBe('400000');
    const totalReserved =
      BigInt(row.local_reserved_minor) + BigInt(row.treasury_reserved_minor);
    expect(totalReserved > BigInt(row.credit_limit_minor)).toBe(true);

    return { programId, token, harness };
  };

  it('refuses an over-limit reservation with PROGRAM_OVER_LIMIT', async () => {
    const { programId, token } = await reachOverLimit(
      'e2e-over-limit',
      'inv-over-limit-seed',
      'over-limit-seed-key',
    );

    const refused = await postReservation(
      programId,
      token,
      'over-limit-refusal-key',
      {
        invoiceId: 'inv-over-limit-1',
        amount: { amountMinor: '1', currency: 'USD' },
      },
    );

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PROGRAM_OVER_LIMIT');
    expectNoLeakedInternals(refused.body);

    const after = await readProgram(programId);
    expect(after.local_reserved_minor).toBe('900000');
  });

  it('clears the over-limit refusal when a later snapshot returns within the limit', async () => {
    const { programId, token, harness } = await reachOverLimit(
      'e2e-over-limit-clearance',
      'inv-over-limit-clearance-seed',
      'over-limit-clearance-seed-key',
    );

    await harness.snapshotHandler.handle(
      snapshotMessage({
        programId,
        version: 2,
        currency: 'USD',
        creditLimitMinor: '1000000',
        reservedMinor: '0',
      }),
    );

    const cleared = await readProgram(programId);
    const clearedTotal =
      BigInt(cleared.local_reserved_minor) +
      BigInt(cleared.treasury_reserved_minor);
    expect(clearedTotal <= BigInt(cleared.credit_limit_minor)).toBe(true);

    const accepted = await postReservation(
      programId,
      token,
      'over-limit-clearance-key',
      {
        invoiceId: 'inv-over-limit-clearance-1',
        amount: { amountMinor: '50000', currency: 'USD' },
      },
    );
    expect(accepted.status).toBe(201);
    expectNoLeakedInternals(accepted.body);

    const after = await readProgram(programId);
    expect(after.local_reserved_minor).toBe('950000');
  });

  it('refuses a second reservation for the same invoice with DUPLICATE_INVOICE', async () => {
    const organisationId = await insertOrganisation(
      fixture.owner,
      'e2e-duplicate-invoice',
    );
    const programId = await insertProgram(fixture.owner, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });
    const token = tokenFor(organisationId, WRITE_SCOPE);

    const first = await postReservation(programId, token, 'dup-key-a', {
      invoiceId: 'inv-dup-1',
      amount: { amountMinor: '100000', currency: 'USD' },
    });
    expect(first.status).toBe(201);
    expectNoLeakedInternals(first.body);

    // The second request carries a DIFFERENT Idempotency-Key. That is what
    // makes this a duplicate-invoice refusal rather than an idempotency replay:
    // with the same key the service would return 200 with the original body,
    // and the scenario would prove nothing.
    const refused = await postReservation(programId, token, 'dup-key-b', {
      invoiceId: 'inv-dup-1',
      amount: { amountMinor: '100000', currency: 'USD' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('DUPLICATE_INVOICE');
    expectNoLeakedInternals(refused.body);

    const after = await readProgram(programId);
    expect(after.local_reserved_minor).toBe('100000');
  });

  it('refuses a request whose Idempotency-Key is pending with REQUEST_IN_FLIGHT', async () => {
    const organisationId = await insertOrganisation(
      fixture.owner,
      'e2e-request-in-flight',
    );
    const programId = await insertProgram(fixture.owner, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });
    const token = tokenFor(organisationId, WRITE_SCOPE);

    const key = 'in-flight-key-1';
    const body = {
      invoiceId: 'inv-in-flight-1',
      amount: { amountMinor: '100000', currency: 'USD' },
    };
    const fingerprint = reserveFingerprintFor(
      programId,
      body.invoiceId,
      body.amount.amountMinor,
      body.amount.currency,
    );

    // Fixture setup for the idempotency table only: a PENDING row cannot be
    // produced deterministically over HTTP without a race. This is not a
    // position write — the `program` row is not touched.
    await fixture.owner.query(
      `INSERT INTO request_record
         (organisation_id, request_id, operation, content_fingerprint, state, outcome, recorded_at)
       VALUES ($1, $2, 'RESERVE', $3, 'PENDING', NULL, now())`,
      [organisationId, key, fingerprint],
    );

    const refused = await postReservation(programId, token, key, body);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('REQUEST_IN_FLIGHT');
    expectNoLeakedInternals(refused.body);
  });

  it('refuses a request whose Idempotency-Key is past retention with IDEMPOTENCY_EXPIRED', async () => {
    const organisationId = await insertOrganisation(
      fixture.owner,
      'e2e-idempotency-expired',
    );
    const programId = await insertProgram(fixture.owner, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });
    const token = tokenFor(organisationId, WRITE_SCOPE);

    const key = 'expired-key-1';
    const body = {
      invoiceId: 'inv-expired-1',
      amount: { amountMinor: '100000', currency: 'USD' },
    };
    const fingerprint = reserveFingerprintFor(
      programId,
      body.invoiceId,
      body.amount.amountMinor,
      body.amount.currency,
    );

    // An EXPIRED row would otherwise require waiting out REQUEST_RETENTION_DAYS
    // (default 30), so the state is inserted directly; 60 days is past it.
    await fixture.owner.query(
      `INSERT INTO request_record
         (organisation_id, request_id, operation, content_fingerprint, state, outcome, recorded_at)
       VALUES ($1, $2, 'RESERVE', $3, 'EXPIRED', NULL, now() - interval '60 days')`,
      [organisationId, key, fingerprint],
    );

    const refused = await postReservation(programId, token, key, body);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('IDEMPOTENCY_EXPIRED');
    expectNoLeakedInternals(refused.body);
  });
});
