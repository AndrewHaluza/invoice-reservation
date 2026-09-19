import 'reflect-metadata';
import { sign } from 'jsonwebtoken';
import { DataSource, EntityManager } from 'typeorm';
import { dataSourceOptions } from '../src/config/data-source';
import { PendingLedgerEntry } from '../src/capacity/domain/ledger-entry';
import { advancePosition } from '../src/capacity/domain/position';
import { ProgramEntity } from '../src/capacity/infrastructure/entities';
import { ProgramRepository } from '../src/capacity/infrastructure/repositories';

export const NORTHWIND_ORGANISATION_ID = 'a1b2c3d4-0001-4000-8000-000000000001';
export const CONTOSO_ORGANISATION_ID = 'a1b2c3d4-0002-4000-8000-000000000002';

export const NORTHWIND_USD_PROGRAM_ID = 'b1b2c3d4-0001-4000-8000-000000000011';
export const NORTHWIND_EUR_PROGRAM_ID = 'b1b2c3d4-0002-4000-8000-000000000012';
export const CONTOSO_USD_PROGRAM_ID = 'b1b2c3d4-0003-4000-8000-000000000013';

export const TOKEN_SCOPE = 'capacity:read capacity:write capacity:audit';

const TOKEN_TTL_SECONDS = 24 * 60 * 60;

interface OrganisationSeed {
  readonly id: string;
  readonly name: string;
}

interface ProgramSeed {
  readonly id: string;
  readonly organisationId: string;
  readonly currency: string;
  readonly creditLimitMinor: bigint;
}

interface FxRateSeed {
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rate: string;
  readonly effectiveAt: Date;
  readonly source: string;
}

export interface SeededToken {
  readonly organisationId: string;
  readonly organisationName: string;
  readonly token: string;
}

export interface SeedResult {
  readonly tokens: readonly SeededToken[];
}

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

const ORGANISATIONS: readonly OrganisationSeed[] = [
  { id: NORTHWIND_ORGANISATION_ID, name: 'Northwind Trading' },
  { id: CONTOSO_ORGANISATION_ID, name: 'Contoso Finance' },
];

const PROGRAMS: readonly ProgramSeed[] = [
  {
    id: NORTHWIND_USD_PROGRAM_ID,
    organisationId: NORTHWIND_ORGANISATION_ID,
    currency: 'USD',
    creditLimitMinor: 10_000_000_00n,
  },
  {
    id: NORTHWIND_EUR_PROGRAM_ID,
    organisationId: NORTHWIND_ORGANISATION_ID,
    currency: 'EUR',
    creditLimitMinor: 5_000_000_00n,
  },
  {
    id: CONTOSO_USD_PROGRAM_ID,
    organisationId: CONTOSO_ORGANISATION_ID,
    currency: 'USD',
    creditLimitMinor: 2_000_000_00n,
  },
];

// quickstart.md Scenario 4 checks this exact rate. Do not round or "correct" it.
const FX_RATES: readonly FxRateSeed[] = [
  {
    baseCurrency: 'EUR',
    quoteCurrency: 'USD',
    rate: '1.0850000000',
    effectiveAt: new Date(0),
    source: 'seed',
  },
  {
    baseCurrency: 'USD',
    quoteCurrency: 'EUR',
    rate: '0.9216589862',
    effectiveAt: new Date(0),
    source: 'seed',
  },
];

interface ProgramRow {
  id: string;
  currency: string;
  credit_limit_minor: string;
  local_reserved_minor: string;
  treasury_reserved_minor: string;
  next_sequence: string;
  over_limit_since: Date | null;
  investigation_required: boolean;
  position_verified: boolean;
}

function assertEnvironment(): void {
  const missing: string[] = [];
  if (!process.env.DATABASE_URL) {
    missing.push('DATABASE_URL');
  }
  if (!process.env.JWT_SECRET) {
    missing.push('JWT_SECRET');
  }
  if (missing.length > 0) {
    throw new SeedError(
      `missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set them before seeding, or the seeded tokens cannot be authenticated.',
    );
  }
}

async function assertMigrationsApplied(manager: EntityManager): Promise<void> {
  const rows = await manager.query<{ program_table: string | null }[]>(
    `SELECT to_regclass('program') AS program_table`,
  );
  if (rows[0]?.program_table == null) {
    throw new SeedError(
      'the program table is missing — migrations have not been applied. ' +
        'Run `npm run migration:run` before seeding.',
    );
  }
}

async function loadProgramForUpdate(
  manager: EntityManager,
  programId: string,
): Promise<ProgramEntity> {
  const rows = await manager.query<ProgramRow[]>(
    'SELECT * FROM program WHERE id = $1 FOR UPDATE',
    [programId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new SeedError(`program ${programId} disappeared mid-seed`);
  }

  const entity = new ProgramEntity();
  entity.id = row.id;
  entity.currency = row.currency;
  entity.creditLimitMinor = BigInt(row.credit_limit_minor);
  entity.localReservedMinor = BigInt(row.local_reserved_minor);
  entity.treasuryReservedMinor = BigInt(row.treasury_reserved_minor);
  entity.nextSequence = BigInt(row.next_sequence);
  entity.overLimitSince = row.over_limit_since;
  entity.investigationRequired = row.investigation_required;
  entity.positionVerified = row.position_verified;
  return entity;
}

/**
 * Seeds the database and returns the minted tokens. Everything runs inside a
 * single transaction, so a failure leaves the database exactly as it was.
 * Re-running is safe: fixed UUIDs plus ON CONFLICT (id) DO NOTHING make every
 * insert idempotent, and the ledger append is guarded on a fresh insert.
 */
export async function runSeed(): Promise<SeedResult> {
  assertEnvironment();

  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();
  try {
    return await dataSource.transaction(async (manager) => {
      await assertMigrationsApplied(manager);

      for (const organisation of ORGANISATIONS) {
        await manager.query(
          `INSERT INTO organisation (id, name)
           VALUES ($1, $2)
           ON CONFLICT (id) DO NOTHING`,
          [organisation.id, organisation.name],
        );
      }

      const programs = new ProgramRepository();
      const now = new Date();

      for (const program of PROGRAMS) {
        const inserted = await manager.query<{ id: string }[]>(
          `INSERT INTO program (id, organisation_id, currency)
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [program.id, program.organisationId, program.currency],
        );

        // A conflicting insert means the program already exists. Do not append a
        // second LIMIT_CHANGE: the ledger sum must stay equal to the cached limit.
        if (inserted.length === 0) {
          continue;
        }

        const entity = await loadProgramForUpdate(manager, program.id);
        const limitChange: PendingLedgerEntry = {
          deltaMinor: program.creditLimitMinor,
          component: 'LIMIT',
          cause: 'LIMIT_CHANGE',
          originReference: null,
          actor: 'seed',
          correlationId: 'seed-limit-change',
        };
        const advanced = advancePosition(
          programs.toPosition(entity),
          [limitChange],
          now,
        );
        await programs.persistAdvance(manager, program.id, advanced, now);
      }

      for (const fxRate of FX_RATES) {
        await manager.query(
          `INSERT INTO fx_rate (base_currency, quote_currency, effective_at, rate, source)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (base_currency, quote_currency, effective_at) DO NOTHING`,
          [
            fxRate.baseCurrency,
            fxRate.quoteCurrency,
            fxRate.effectiveAt,
            fxRate.rate,
            fxRate.source,
          ],
        );
      }

      const secret = process.env.JWT_SECRET as string;
      const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
      const tokens: SeededToken[] = ORGANISATIONS.map((organisation) => ({
        organisationId: organisation.id,
        organisationName: organisation.name,
        token: sign({ org: organisation.id, scope: TOKEN_SCOPE, exp }, secret, {
          algorithm: 'HS256',
        }),
      }));

      return { tokens };
    });
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

async function main(): Promise<void> {
  const { tokens } = await runSeed();

  // Tokens go to stdout and nowhere else. Writing them to a file in the repository is how
  // a development credential becomes a committed one.
  for (const { organisationName, organisationId, token } of tokens) {
    process.stdout.write(`organisation=${organisationName} id=${organisationId}\n`);
    process.stdout.write(`token=${token}\n`);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`seed failed: ${message}\n`);
    process.exitCode = 1;
  });
}
