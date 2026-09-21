/**
 * The capacity boundary, pinned at its exact edge.
 *
 * `decideReservation` checks refusals in a fixed order: POSITION_UNVERIFIED →
 * PROGRAM_OVER_LIMIT → FX_RATE_UNAVAILABLE → AMOUNT_ROUNDS_TO_ZERO →
 * INSUFFICIENT_CAPACITY. Any of the first four left unsatisfied means the
 * boundary comparison is never reached and the test would pass for the wrong
 * reason. Every program below is therefore `position_verified` true (the
 * `insertProgram` default), within its limit, and denominated `'USD'` on both
 * the program and the request, so no FX conversion is involved.
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

const availableOf = (row: ProgramRow): bigint =>
  BigInt(row.credit_limit_minor) -
  (BigInt(row.local_reserved_minor) + BigInt(row.treasury_reserved_minor));

describe('capacity boundary over HTTP', () => {
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

  it('accepts a reservation for exactly the available boundary and leaves nothing remaining', async () => {
    const organisationId = await insertOrganisation(
      fixture.owner,
      'e2e-boundary-exact',
    );
    const programId = await insertProgram(fixture.owner, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });
    const token = tokenFor(organisationId, WRITE_SCOPE);

    const row = await readProgram(programId);
    const available = availableOf(row);
    // A zero `available` would send `'0'`, which the PositiveMoneyDto regex
    // rejects with 400 VALIDATION_FAILED, and the edge would never be reached.
    expect(available > 0n).toBe(true);

    const accepted = await postReservation(
      programId,
      token,
      'boundary-exact-key',
      {
        invoiceId: 'inv-boundary-exact',
        amount: { amountMinor: available.toString(), currency: 'USD' },
      },
    );
    expect(accepted.status).toBe(201);
    expect(accepted.body.availability.available.amountMinor).toBe('0');

    const after = await readProgram(programId);
    expect(after.local_reserved_minor).toBe(available.toString());
  });

  /**
   * This pair — reserving exactly `available`, then `available + 1` — is what
   * kills a `>` to `>=` mutation in
   * `src/capacity/domain/policies/reserve.policy.ts`. That mutation changes
   * behaviour for exactly one input: a request for precisely the remaining
   * amount. The existing thousand-request storm in
   * `test/integration/concurrency.spec.ts` reserves 1,000 against a 100,000
   * limit, so no request in it ever lands on the edge and the mutation slips
   * past it.
   */
  it('refuses a reservation one unit over the boundary with INSUFFICIENT_CAPACITY', async () => {
    const organisationId = await insertOrganisation(
      fixture.owner,
      'e2e-boundary-over',
    );
    const programId = await insertProgram(fixture.owner, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });
    const token = tokenFor(organisationId, WRITE_SCOPE);

    const row = await readProgram(programId);
    const available = availableOf(row);
    expect(available > 0n).toBe(true);
    const requested = available + 1n;

    const refused = await postReservation(
      programId,
      token,
      'boundary-over-key',
      {
        invoiceId: 'inv-boundary-over',
        amount: { amountMinor: requested.toString(), currency: 'USD' },
      },
    );
    expect({ status: refused.status, code: refused.body.code }).toEqual({
      status: 409,
      code: 'INSUFFICIENT_CAPACITY',
    });
    // The policy sets both details; asserting them pins the arithmetic rather
    // than merely the outcome.
    expect(refused.body.details.requestedMinor).toBe(requested.toString());
    expect(refused.body.details.availableMinor).toBe(available.toString());

    const after = await readProgram(programId);
    expect(after.local_reserved_minor).toBe('0');
  });

  it('returns capacity to the boundary after a release', async () => {
    const organisationId = await insertOrganisation(
      fixture.owner,
      'e2e-boundary-return',
    );
    const programId = await insertProgram(fixture.owner, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });
    const token = tokenFor(organisationId, WRITE_SCOPE);

    const row = await readProgram(programId);
    const available = availableOf(row);
    expect(available > 0n).toBe(true);

    const full = await postReservation(
      programId,
      token,
      'boundary-return-full-key',
      {
        invoiceId: 'inv-boundary-return',
        amount: { amountMinor: available.toString(), currency: 'USD' },
      },
    );
    expect(full.status).toBe(201);

    const refused = await postReservation(
      programId,
      token,
      'boundary-return-refused-key',
      {
        invoiceId: 'inv-boundary-return-refused',
        amount: { amountMinor: '1', currency: 'USD' },
      },
    );
    expect({ status: refused.status, code: refused.body.code }).toEqual({
      status: 409,
      code: 'INSUFFICIENT_CAPACITY',
    });

    const released = await postRelease(
      programId,
      token,
      'inv-boundary-return',
      'boundary-return-release-key',
      { amount: { amountMinor: '250000', currency: 'USD' } },
    );
    expect(released.status).toBe(201);

    const afterRelease = await readProgram(programId);
    expect(afterRelease.local_reserved_minor).toBe(
      (available - 250000n).toString(),
    );

    const reReserved = await postReservation(
      programId,
      token,
      'boundary-return-rereserve-key',
      {
        invoiceId: 'inv-boundary-return-again',
        amount: { amountMinor: '250000', currency: 'USD' },
      },
    );
    expect(reReserved.status).toBe(201);

    const final = await readProgram(programId);
    expect(final.local_reserved_minor).toBe(available.toString());
  });
});
