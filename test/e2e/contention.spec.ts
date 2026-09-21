/**
 * What this suite deliberately does NOT test, and why.
 *
 * A genuine multi-program deadlock needs two transactions that take two
 * programs in opposite orders. `src/capacity/infrastructure/unit-of-work.ts`
 * locks exactly one program per transaction, and every write route is mounted
 * under `v1/programs/:programId`, so no supported request can express it
 * (R-006). FR-013 forbids simulating it below the API and presenting the result
 * as end-to-end evidence. The debt is explicit: the day a multi-program
 * endpoint lands, deadlock coverage is owed.
 */
import request from 'supertest';
import type { E2eApp } from '../support/e2e-app';
import {
  startE2eApp,
  stopE2eApp,
  tokenFor,
  WRITE_SCOPE,
} from '../support/e2e-app';
import { insertOrganisation, insertProgram } from '../support/treasury';

jest.setTimeout(300_000);

interface ProgramRow {
  credit_limit_minor: string;
  local_reserved_minor: string;
  treasury_reserved_minor: string;
}

interface HttpResponse {
  status: number;
  body: unknown;
}

describe('single-program contention over HTTP', () => {
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

  const postRelease = (
    programId: string,
    token: string,
    invoiceId: string,
    idempotencyKey: string,
    body: object,
  ) =>
    request(fixture.app.getHttpServer())
      .post(`/v1/programs/${programId}/reservations/${invoiceId}/releases`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);

  const postCancellation = (
    programId: string,
    token: string,
    invoiceId: string,
    idempotencyKey: string,
    body: object,
  ) =>
    request(fixture.app.getHttpServer())
      .post(`/v1/programs/${programId}/reservations/${invoiceId}/cancellation`)
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

  /**
   * A contention failure is any response that is not an accepted `201`: a
   * serialization (`40001`) or deadlock (`40P01`) code reaching a caller is the
   * defect this scenario catches, and a `429` from the rate limit is a fixture
   * defect that must fail loudly rather than pass as contention.
   */
  const expectAccepted = (response: HttpResponse): void => {
    expect(response.status).toBe(201);
    expect(response.status).toBeLessThan(500);
    const text = JSON.stringify(response.body);
    expect(text).not.toContain('40001');
    expect(text).not.toContain('40P01');
  };

  it('accepts five simultaneous reservations under contention and records the exact position', async () => {
    const organisationId = await insertOrganisation(
      fixture.owner,
      'e2e-contention-reservations',
    );
    const programId = await insertProgram(fixture.owner, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });
    const token = tokenFor(organisationId, WRITE_SCOPE);

    // Five is deliberate: enough to serialize on the program row lock, far
    // short of the thousand-request storm in
    // `test/integration/concurrency.spec.ts`, which FR-012 forbids duplicating.
    const invoiceIds = [
      'inv-contention-0',
      'inv-contention-1',
      'inv-contention-2',
      'inv-contention-3',
      'inv-contention-4',
    ];

    const responses = await Promise.all(
      invoiceIds.map((invoiceId, index) =>
        postReservation(programId, token, `contention-key-${index}`, {
          invoiceId,
          amount: { amountMinor: '10000', currency: 'USD' },
        }),
      ),
    );

    responses.forEach(expectAccepted);

    // No write lost, none double-counted: the exact sum of the five accepted
    // reservations.
    const after = await readProgram(programId);
    expect(after.local_reserved_minor).toBe('50000');
  });

  it('accepts a mixed reservation, release and cancellation burst under contention', async () => {
    const organisationId = await insertOrganisation(
      fixture.owner,
      'e2e-contention-mixed',
    );
    const programId = await insertProgram(fixture.owner, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });
    const token = tokenFor(organisationId, WRITE_SCOPE);

    const released = await postReservation(
      programId,
      token,
      'contention-mixed-release-seed-key',
      {
        invoiceId: 'inv-mixed-release',
        amount: { amountMinor: '100000', currency: 'USD' },
      },
    );
    expectAccepted(released);

    const cancelled = await postReservation(
      programId,
      token,
      'contention-mixed-cancel-seed-key',
      {
        invoiceId: 'inv-mixed-cancel',
        amount: { amountMinor: '100000', currency: 'USD' },
      },
    );
    expectAccepted(cancelled);

    const responses = await Promise.all([
      postReservation(programId, token, 'contention-mixed-new-key', {
        invoiceId: 'inv-mixed-new',
        amount: { amountMinor: '50000', currency: 'USD' },
      }),
      postRelease(
        programId,
        token,
        'inv-mixed-release',
        'contention-mixed-release-key',
        { amount: { amountMinor: '40000', currency: 'USD' } },
      ),
      postCancellation(
        programId,
        token,
        'inv-mixed-cancel',
        'contention-mixed-cancel-key',
        { reason: 'CANCELLED' },
      ),
    ]);

    responses.forEach(expectAccepted);

    // 100000 + 100000 + 50000 - 40000 - 100000 = 110000.
    const after = await readProgram(programId);
    expect(after.local_reserved_minor).toBe('110000');
  });
});
