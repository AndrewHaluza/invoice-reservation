# Execution Plan: Phase 1 Setup — project scaffold, coverage gate, boundary lint, local stack

## Goal

The repository holds a compiling, lintable NestJS 11 skeleton on Node 22 with a **failing**
80% coverage gate wired into Jest, a lint rule that mechanically enforces the two dependency
boundaries plan.md declares, a `docker compose up` stack (PostgreSQL 16 + Redpanda with SASL),
and a fail-fast configuration module. No domain code, no entities, no endpoints.

This is tasks **T001–T008** of `specs/001-program-capacity-reservation/tasks.md`.

## Current State

Verified by inspection at plan time:

- Repo root `/Users/nd/Work/projects/invoice-reservation`, git initialized, baseline branch
  `develop`, one commit (`65d5fc9`), clean tree, remote `origin` →
  `https://github.com/AndrewHaluza/invoice-reservation.git` (empty, nothing pushed).
- Contents: `.claude/`, `.karst/`, `.specify/`, `specs/`, `docs/plans/`, `.gitignore`.
- **There is no `package.json`, no `src/`, no `test/`, no `node_modules/`.** This is a greenfield
  scaffold. Nothing here can break.
- `.gitignore` already ignores `node_modules/`, `dist/`, `coverage/`, `.env`, `*.log`,
  `.karst/worktrees/`.
- Local Node is `v22.22.0`. npm is available.
- `specs/001-program-capacity-reservation/plan.md` fixes the stack: NestJS 11, Node.js 22 LTS,
  TypeScript 5.6, TypeORM, KafkaJS, PostgreSQL 16, Jest, Testcontainers.
- `.specify/memory/constitution.md` is at v2.1.0. Principle VI is NON-NEGOTIABLE and requires
  minimum 80% coverage.

## Target State

- `npm install` succeeds; `npx tsc --noEmit` passes; `npx eslint .` passes.
- `npx jest --coverage` runs, finds the single placeholder test, and **exits non-zero** because
  global coverage is below the 80% threshold. This failure is the deliverable, not a defect.
- `docker compose up -d` brings up `postgres` and `redpanda`, both reporting healthy.
- `src/config/configuration.module.ts` throws at startup when a required variable is absent.

## Scope

### In Scope

- `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`
- `jest.config.ts` with the coverage threshold
- `eslint.config.mjs` with import-boundary rules
- `.prettierrc`
- `docker-compose.yml`, `.env.example`
- `src/config/` (module + schema), `src/main.ts`, `src/app.module.ts` as minimal bootstraps
- One placeholder unit test so Jest has something to run

### Out of Scope

- Any entity, migration, domain policy, service, controller, guard, consumer — Phase 2 onward
- `Money`, `Result`, correlation id — those are T009–T014 in Phase 2, a different ticket
- Installing or configuring Redis for throttling (T030, Phase 2)
- Pushing to `origin`
- Editing anything under `specs/`, `.specify/`, or `.karst/`

## Key Decisions

1. **Pin the NestJS 11 line exactly as plan.md specifies, not the newest release.**
   At plan time npm `latest` is NestJS **12.0.3**, TypeORM **1.1.1**, TypeScript **7.0.2**. The
   approved plan.md says NestJS 11 / TypeORM 0.3 / TypeScript 5.6. Deviating from an approved
   plan is precisely what the executor is forbidden to do, and a planner should not do it
   silently either. Every version below is therefore pinned to the 11-era line, which is fully
   supported and mutually compatible. Verified: `@nestjs/typeorm@11.0.3` peers accept
   `@nestjs/core` 10/11/12 and `typeorm ^0.3.0`; `ts-jest@29.4.12` peers accept
   `typescript >=4.3 <7` and `jest ^29 || ^30`.

2. **Exact versions, caret-free, in `dependencies`.** A financial ledger service should not
   resolve a different minor on a rebuild. All versions are written without `^` or `~`.

3. **`@nestjs/config` + `joi` for configuration**, not a hand-rolled loader. `validationSchema`
   with `abortEarly: false` gives the fail-fast-at-startup behavior T008 requires and reports
   every missing variable at once rather than one per restart.

4. **ESLint flat config (`eslint.config.mjs`) with `eslint-plugin-boundaries`.** Flat config is
   the only format ESLint 9 supports by default. `boundaries/element-types` expresses both rules
   plan.md declares as a matrix, so violations fail `npx eslint .` rather than depending on a
   reviewer noticing.

5. **Redpanda runs with SASL enabled locally.** research R11 requires the authenticated path be
   the one exercised locally. `redpanda start --set redpanda.enable_sasl=true` plus a bootstrap
   superuser, so the code written in Phase 7 authenticates from the first run rather than having
   auth bolted on at deploy time.

6. **One placeholder test (`test/unit/scaffold.spec.ts`) asserting `1 + 1 === 2`.** Jest exits
   non-zero with "no tests found" when a suite is empty, which is indistinguishable from a
   broken config. A trivially passing test makes the *coverage* failure the only failure, which
   is what T004 is proving. It is deleted in Phase 2 by T010.

7. **`coverageThreshold.global` at 80 for all four counters, with
   `collectCoverageFrom: ['src/**/*.ts']`** and `main.ts` / `*.module.ts` excluded. Bootstrap
   files are wiring with no branches; including them inflates the denominator with code no test
   should meaningfully cover.

8. **Postgres 16.10 and Redpanda v24.2.18 pinned by tag**, not `:latest`. A ledger's constraint
   and trigger behavior is version-sensitive; `:latest` silently changing the database engine
   under a financial invariant is unacceptable.

## Execution Order

### Task 1: Initialize the npm project, TypeScript strict config, and Nest CLI config

#### Objective

Create a compiling, empty NestJS project skeleton with TypeScript in strict mode. Covers T001.

#### Files

- `package.json` — created. Project manifest, scripts, dependency pins.
- `tsconfig.json` — created. Strict compiler options for editor and `tsc --noEmit`.
- `tsconfig.build.json` — created. Build variant excluding tests.
- `nest-cli.json` — created. Nest CLI source root.
- `.prettierrc` — created. Formatting, referenced by the lint script.

#### Implementation

1. Create `package.json` exactly:

```json
{
  "name": "invoice-reservation",
  "version": "0.1.0",
  "private": true,
  "description": "Program Capacity & Invoice Reservation",
  "engines": { "node": ">=22.0.0 <23" },
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "lint": "eslint .",
    "format": "prettier --write \"src/**/*.ts\" \"test/**/*.ts\"",
    "typecheck": "tsc --noEmit",
    "test": "jest",
    "test:cov": "jest --coverage",
    "test:unit": "jest --selectProjects unit",
    "migration:run": "typeorm-ts-node-commonjs migration:run -d src/config/data-source.ts"
  }
}
```

Note: the `migration:run` script references `src/config/data-source.ts`, which **does not exist
yet** and is created in Phase 2 by T015. The script is declared now so Phase 2 does not have to
edit `package.json`. Do not create `data-source.ts` in this task.

2. Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2023",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strict": true,
    "strictNullChecks": true,
    "noImplicitAny": true,
    "strictBindCallApply": true,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are required by T001's
"strict mode" and are load-bearing for the money code in Phase 2.

3. Create `tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
```

4. Create `nest-cli.json`:

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": { "deleteOutDir": true }
}
```

5. Create `.prettierrc`:

```json
{ "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

#### Constraints

- Do not run `nest new` or any scaffolding generator — it creates an opinionated tree that
  conflicts with the structure plan.md specifies.
- Do not add dependencies in this task; Task 2 owns that.
- Do not modify `.gitignore` — it is already correct.

#### Edge Cases

- If `package.json` already exists, the repo is not in the state this plan assumes. **Stop and
  report**, do not merge into it.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation
test -f package.json && test -f tsconfig.json && test -f nest-cli.json && echo FILES_OK
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); JSON.parse(require('fs').readFileSync('tsconfig.json','utf8')); console.log('JSON_OK')"
```

Expected: `FILES_OK` then `JSON_OK`.

#### Completion Criteria

- [ ] `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `.prettierrc` exist
- [ ] All parse as valid JSON
- [ ] `tsconfig.json` contains `"strict": true` and `"noUncheckedIndexedAccess": true`
- [ ] No `node_modules/` yet, no `src/` yet

---

### Task 2: Install all runtime and development dependencies at pinned versions

#### Objective

Populate `dependencies` and `devDependencies` with exact pins and produce a lockfile. Covers
T002 and T003.

#### Files

- `package.json` — modified. Adds `dependencies` and `devDependencies` blocks.
- `package-lock.json` — created by npm.

#### Implementation

1. Add to `package.json` a `dependencies` block with these **exact** versions (no `^`, no `~`):

```json
"dependencies": {
  "@nestjs/common": "11.2.5",
  "@nestjs/core": "11.2.5",
  "@nestjs/platform-express": "11.2.5",
  "@nestjs/config": "4.0.4",
  "@nestjs/typeorm": "11.0.3",
  "@nestjs/terminus": "11.1.1",
  "@nestjs/throttler": "6.7.0",
  "@nestjs/jwt": "11.0.2",
  "@nestjs/schedule": "5.0.1",
  "typeorm": "0.3.31",
  "pg": "8.23.0",
  "kafkajs": "2.2.4",
  "class-validator": "0.15.1",
  "class-transformer": "0.5.1",
  "nestjs-pino": "5.2.0",
  "pino-http": "11.0.0",
  "prom-client": "15.1.3",
  "joi": "18.2.9",
  "reflect-metadata": "0.2.2",
  "rxjs": "7.8.2"
}
```

2. Add a `devDependencies` block with these **exact** versions:

```json
"devDependencies": {
  "@nestjs/cli": "11.0.24",
  "@nestjs/schematics": "11.1.0",
  "@nestjs/testing": "11.2.5",
  "@types/express": "5.0.6",
  "@types/jest": "29.5.14",
  "@types/node": "22.20.4",
  "@types/supertest": "7.2.1",
  "typescript": "5.6.3",
  "ts-node": "10.9.2",
  "ts-jest": "29.4.12",
  "jest": "29.7.0",
  "supertest": "7.2.2",
  "testcontainers": "12.1.0",
  "@testcontainers/postgresql": "12.1.0",
  "@testcontainers/redpanda": "12.1.0",
  "eslint": "9.39.5",
  "typescript-eslint": "8.70.0",
  "eslint-plugin-boundaries": "7.2.0",
  "prettier": "3.9.8"
}
```

3. Run `npm install`.

4. If npm reports a peer-dependency conflict, **stop and report it** with the exact npm output.
   Do not add `--legacy-peer-deps`, do not change a pin to resolve it. The pins were verified
   compatible at plan time; a conflict means a fact this plan depends on is false.

5. If `@nestjs/schematics@11.1.0`, `@types/express@5.0.6`, `typescript-eslint@8.70.0`, or
   `ts-node@10.9.2` does not resolve, install the highest available version within the same
   major (`11.x`, `5.x`, `8.x`, `10.x` respectively) and record the substitution in the task
   report. These four are tooling-only and do not affect runtime behavior. **This latitude
   applies to these four packages only** — every other pin is exact and a failure to resolve is
   a stop condition.

#### Constraints

- Do not install Redis, `ioredis`, or `@nest-lab/throttler-storage-redis`. The Redis-backed
  throttler store is T030 in Phase 2.
- Do not install `decimal.js`, `big.js`, or any money library — Constitution I mandates integer
  minor units.
- Do not add packages not listed above.
- Do not run `npm audit fix` — it rewrites pins.

#### Edge Cases

- A network failure mid-install leaves a partial `node_modules/`. Re-run `npm install`; if it
  fails twice, stop and report.
- npm may emit deprecation warnings for transitive packages. Warnings are not failures; proceed.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation
npm install
npx tsc --version
node -e "const p=require('./package.json'); const bad=Object.entries({...p.dependencies,...p.devDependencies}).filter(([k,v])=>/[\^~]/.test(v)); if(bad.length){console.error('UNPINNED:',bad);process.exit(1)} console.log('ALL_PINNED')"
test -f package-lock.json && echo LOCKFILE_OK
```

Expected: install completes, `Version 5.6.3`, `ALL_PINNED`, `LOCKFILE_OK`.

#### Completion Criteria

- [ ] `npm install` exits 0
- [ ] `package-lock.json` exists
- [ ] `npx tsc --version` reports `5.6.3`
- [ ] No dependency version string contains `^` or `~`
- [ ] `node_modules/@nestjs/core/package.json` reports version `11.2.5`

---

### Task 3: Create the minimal application bootstrap and the fail-fast configuration module

#### Objective

Give the project a compiling entrypoint and a configuration module that refuses to start when a
required variable is missing. Covers T008.

#### Files

- `src/config/env.schema.ts` — created. Joi schema, the single source of truth for env vars.
- `src/config/configuration.module.ts` — created. Global `ConfigModule` wired to the schema.
- `src/app.module.ts` — created. Root module importing the configuration module only.
- `src/main.ts` — created. Bootstrap.

#### Implementation

1. `src/config/env.schema.ts` — export `const envSchema` built with `joi`:

| key | type | required | default |
|---|---|---|---|
| `NODE_ENV` | string, one of `development`,`test`,`production` | no | `development` |
| `PORT` | number, port | no | `3000` |
| `DATABASE_URL` | string, uri | **yes** | — |
| `KAFKA_BROKERS` | string | **yes** | — |
| `KAFKA_SASL_USERNAME` | string | **yes** | — |
| `KAFKA_SASL_PASSWORD` | string | **yes** | — |
| `KAFKA_CAPACITY_EVENTS_TOPIC` | string | no | `treasury.capacity.events` |
| `KAFKA_SNAPSHOTS_TOPIC` | string | no | `treasury.capacity.snapshots` |
| `KAFKA_DLQ_TOPIC` | string | no | `treasury.capacity.dlq` |
| `JWT_SECRET` | string, min length 32 | **yes** | — |
| `JWT_CLOCK_SKEW_SECONDS` | number, integer, min 0 | no | `60` |
| `SNAPSHOT_DELTA_GUARD_RATIO` | number, greater than 0, less than or equal to 1 | no | `0.5` |
| `RATE_LIMIT_READ_PER_MINUTE` | number, integer, positive | no | `600` |
| `RATE_LIMIT_WRITE_PER_MINUTE` | number, integer, positive | no | `120` |

`SNAPSHOT_DELTA_GUARD_RATIO` is the FR-032 magnitude guard: a snapshot implying a treasury
correction above this proportion of the credit limit is quarantined rather than auto-applied.
`0.5` matches `data-model.md`.

`JWT_SECRET` has `min(32)` so a short placeholder cannot reach production.

2. `src/config/configuration.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from './env.schema';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: envSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
    }),
  ],
})
export class ConfigurationModule {}
```

`abortEarly: false` reports every missing variable in one startup failure rather than one per
restart. `allowUnknown: true` so unrelated shell variables do not fail the boot.

3. `src/app.module.ts` — a `@Module` importing `ConfigurationModule` only. No controllers, no
   providers.

4. `src/main.ts` — `NestFactory.create(AppModule)`, read `PORT` from `ConfigService`, listen,
   log the port with `console.log`. Do not wire `nestjs-pino`, `ValidationPipe`, guards, or
   Swagger here — those are T031 and T027 in Phase 2.

#### Constraints

- Do not import `TypeOrmModule` — there are no entities and no `data-source.ts` until Phase 2,
  and importing it now makes the app fail to boot without a database.
- Do not create `src/capacity/`, `src/treasury/`, `src/auth/`, `src/fx/`, `src/shared/`, or
  `src/observability/`. Task 4's lint config references those paths by pattern; the patterns
  match zero files until later phases, which is correct and not an error.
- Do not add a `.env` file. Only `.env.example` (Task 5).

#### Edge Cases

- Booting with no `.env` and no exported variables must fail with a Joi error naming
  `DATABASE_URL`, `KAFKA_BROKERS`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD` and
  `JWT_SECRET`. That failure is the feature; verification asserts it.
- `JWT_SECRET` shorter than 32 characters must fail validation, not warn.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation
npx tsc --noEmit && echo TYPECHECK_OK

# Missing config must fail, and name every missing key
env -i PATH="$PATH" HOME="$HOME" npx ts-node -r tsconfig-paths/register src/main.ts 2>&1 | head -20 || true
```

Expected: `TYPECHECK_OK`. The second command exits non-zero and its output names
`DATABASE_URL`, `KAFKA_BROKERS`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, and `JWT_SECRET`.

If `ts-node` cannot resolve `tsconfig-paths/register`, drop the `-r tsconfig-paths/register`
flag and re-run — no path aliases are configured, so it is not required.

#### Completion Criteria

- [ ] `npx tsc --noEmit` exits 0
- [ ] Booting with an empty environment exits non-zero
- [ ] That failure output names all five required variables in one message
- [ ] `src/` contains exactly `main.ts`, `app.module.ts`, `config/env.schema.ts`,
      `config/configuration.module.ts`

---

### Task 4: Wire the Jest coverage gate and the ESLint boundary rules

#### Objective

Make the 80% coverage floor a build failure, and make plan.md's two dependency rules
mechanically enforced. Covers T004 and T005.

**This task is the reason Phase 1 exists.** Constitution VI's coverage requirement was asserted
in three documents and enforced in none; `jest.config.ts` is what converts it into a gate.

#### Files

- `jest.config.ts` — created. Coverage threshold.
- `eslint.config.mjs` — created. Flat config with boundary rules.
- `test/unit/scaffold.spec.ts` — created. Placeholder so Jest has a suite to run.

#### Implementation

1. `jest.config.ts`:

```ts
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/main.ts',
    '!src/**/*.module.ts',
    '!src/migrations/**',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
};

export default config;
```

2. `test/unit/scaffold.spec.ts`:

```ts
describe('scaffold', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

This exists only so Jest finds a suite. An empty run exits non-zero with "no tests found",
which would be indistinguishable from a broken config — and the point of this task is to prove
the *coverage* gate fires. It is deleted in Phase 2 by T010.

3. `eslint.config.mjs` — flat config exporting an array with:

   - `typescript-eslint` recommended rules applied to `**/*.ts`
   - `eslint-plugin-boundaries` with `settings['boundaries/elements']`:

| type | pattern |
|---|---|
| `domain` | `src/capacity/domain/**` |
| `application` | `src/capacity/application/**` |
| `infrastructure` | `src/capacity/infrastructure/**` |
| `api` | `src/capacity/api/**` |
| `treasury` | `src/treasury/**` |
| `shared` | `src/shared/**` |
| `fx` | `src/fx/**` |
| `auth` | `src/auth/**` |
| `config` | `src/config/**` |
| `observability` | `src/observability/**` |

   - Rule `boundaries/element-types` set to `error` with `default: 'disallow'` and an `allow`
     matrix encoding exactly the two rules plan.md declares:

     - `domain` may import: `domain`, `shared`. **Nothing else.** This is plan.md's rule that
       `capacity/domain/` imports nothing from `infrastructure/`, `api/`, or Kafka.
     - `application` may import: `domain`, `infrastructure`, `shared`, `fx`, `config`
     - `infrastructure` may import: `domain`, `shared`, `config`
     - `api` may import: `application`, `domain`, `shared`
     - `treasury` may import: `application`, `shared`, `config`, `observability`.
       **`treasury` may NOT import `infrastructure` or `domain`.** This is plan.md's second
       rule: `treasury/` parses, validates, dedupes and dispatches; it never writes the capacity
       aggregate. Without this rule a second module holds write access to the aggregate's
       internals and a future change to the position-advance sequence silently misses one writer.
     - `fx` may import: `domain`, `shared`, `config`
     - `auth` may import: `shared`, `config`
     - `shared`, `config`, `observability` may import: `shared`, `config`

   - `ignores`: `dist/**`, `coverage/**`, `node_modules/**`, `jest.config.ts`,
     `eslint.config.mjs`, `specs/**`, `docs/**`, `.specify/**`, `.karst/**`

4. Set `settings['boundaries/include'] = ['src/**/*.ts']` so test files are not subject to the
   matrix.

#### Constraints

- Do not lower any of the four thresholds below 80. Constitution VI is NON-NEGOTIABLE.
- Do not add `coveragePathIgnorePatterns` entries beyond those listed — excluding domain code
  from coverage defeats the gate.
- Do not add `--passWithNoTests` to any script.
- Do not add exceptions to the `domain` or `treasury` rows of the allow matrix.

#### Edge Cases

- The boundary patterns match zero files right now, because `src/capacity/` does not exist until
  Phase 2. `eslint` must still exit 0 — an empty match is not an error. If
  `eslint-plugin-boundaries` errors on an element type matching no files, set
  `boundaries/no-unknown-files` to `off` and leave `element-types` on.
- `jest --coverage` with only the scaffold test yields near-0% coverage of `src/`, so the
  threshold fails. **That is the expected result of this task**, not a defect to fix.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation

npx eslint . ; echo "eslint exit=$?"

npx jest ; echo "jest exit=$?"

npx jest --coverage ; echo "coverage exit=$?"
```

Expected:
- `eslint exit=0`
- `jest exit=0` — the scaffold test passes
- `coverage exit=1` — **non-zero**, with output containing
  `Jest: "global" coverage threshold for statements (80%) not met`

The third result is the proof that the gate is live. A `coverage exit=0` here means the
threshold is not wired and the task is **not** complete.

#### Completion Criteria

- [ ] `jest.config.ts` exists with all four `coverageThreshold.global` counters at 80
- [ ] `npx eslint .` exits 0
- [ ] `npx jest` exits 0
- [ ] `npx jest --coverage` exits **non-zero** citing an unmet global coverage threshold
- [ ] The `boundaries/element-types` allow matrix denies `domain → infrastructure` and
      `treasury → infrastructure`

---

### Task 5: Create the local stack — docker-compose and .env.example

#### Objective

`docker compose up -d` brings up PostgreSQL 16 and a SASL-authenticated Redpanda, both healthy.
Covers T006 and T007.

#### Files

- `docker-compose.yml` — created. Postgres + Redpanda.
- `.env.example` — created. Every variable in `src/config/env.schema.ts`, with local values.

#### Implementation

1. `docker-compose.yml` with two services and no `version:` key (obsolete in Compose v2):

   **`postgres`**
   - `image: postgres:16.10-alpine`
   - `environment`: `POSTGRES_USER=capacity`, `POSTGRES_PASSWORD=capacity_local_dev`,
     `POSTGRES_DB=capacity`
   - `ports`: `5432:5432`
   - `healthcheck`: `["CMD-SHELL", "pg_isready -U capacity -d capacity"]`,
     `interval: 5s`, `timeout: 5s`, `retries: 10`
   - `volumes`: named volume `pgdata` at `/var/lib/postgresql/data`

   **`redpanda`**
   - `image: docker.redpanda.com/redpandadata/redpanda:v24.2.18`
   - `command`:
     ```
     redpanda start
       --smp 1
       --overprovisioned
       --node-id 0
       --check=false
       --kafka-addr PLAINTEXT://0.0.0.0:9092,SASL://0.0.0.0:9093
       --advertise-kafka-addr PLAINTEXT://localhost:9092,SASL://localhost:9093
       --set redpanda.enable_sasl=true
       --set redpanda.superusers=["capacity"]
     ```
   - `ports`: `9092:9092`, `9093:9093`, `9644:9644`
   - `healthcheck`: `["CMD-SHELL", "rpk cluster health | grep -q 'Healthy:.*true'"]`,
     `interval: 5s`, `timeout: 5s`, `retries: 20`, `start_period: 10s`

   **`redpanda-init`** — a one-shot service, `depends_on: redpanda: {condition: service_healthy}`,
   same image, `restart: "no"`, running `rpk` to create the SASL user `capacity` with password
   `capacity_local_dev` and mechanism `SCRAM-SHA-512`, then create the three topics
   `treasury.capacity.events`, `treasury.capacity.snapshots`, `treasury.capacity.dlq`, each with
   3 partitions and replication factor 1.

   Two listeners are deliberate: the PLAINTEXT listener on 9092 is what `rpk` inside the
   container uses for administration, and the SASL listener on 9093 is what the service
   authenticates against, so research R11's authenticated path is the one the application
   exercises from the first run.

2. `.env.example` containing every key from the schema:

```
NODE_ENV=development
PORT=3000

DATABASE_URL=postgresql://capacity:capacity_local_dev@localhost:5432/capacity

KAFKA_BROKERS=localhost:9093
KAFKA_SASL_USERNAME=capacity
KAFKA_SASL_PASSWORD=capacity_local_dev
KAFKA_CAPACITY_EVENTS_TOPIC=treasury.capacity.events
KAFKA_SNAPSHOTS_TOPIC=treasury.capacity.snapshots
KAFKA_DLQ_TOPIC=treasury.capacity.dlq

# Local development only. Obviously fake by construction — never a production secret.
JWT_SECRET=dev-only-not-a-real-secret-0000000000
JWT_CLOCK_SKEW_SECONDS=60

SNAPSHOT_DELTA_GUARD_RATIO=0.5
RATE_LIMIT_READ_PER_MINUTE=600
RATE_LIMIT_WRITE_PER_MINUTE=120
```

The `JWT_SECRET` value is 36 characters, satisfying the schema's `min(32)`, and is written so
no reader could mistake it for a real secret. T007 requires exactly this.

#### Constraints

- Do not create a `.env` file. `.gitignore` excludes it; the executor must not author one.
- Do not use `:latest` for either image.
- Do not disable the Redpanda SASL listener to simplify local setup.
- Do not add a service for the application itself. The app is not containerized in Phase 1;
  it runs on the host against these two containers.
- Do not add Redis — that is T030 in Phase 2.

#### Edge Cases

- Port 5432 or 9092 already bound on the developer's machine: compose fails with a clear bind
  error. Do not remap the ports in the committed file — report it instead; the quickstart
  assumes these ports.
- `redpanda-init` exits 0 after creating topics and stays exited. That is correct; it must not
  be given a `restart: always`.
- Re-running `docker compose up -d` must be idempotent: user and topic creation commands must
  tolerate "already exists" and still exit 0. Chain them so an existing resource is not a
  failure.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation
docker compose config >/dev/null && echo COMPOSE_VALID

docker compose up -d
sleep 30
docker compose ps

docker compose exec -T postgres pg_isready -U capacity -d capacity
docker compose exec -T redpanda rpk cluster health
docker compose exec -T redpanda rpk topic list

docker compose down
```

Expected:
- `COMPOSE_VALID`
- `postgres` and `redpanda` both show `healthy` in `docker compose ps`
- `pg_isready` reports `accepting connections`
- `rpk cluster health` reports `Healthy: true`
- `rpk topic list` lists `treasury.capacity.events`, `treasury.capacity.snapshots`,
  `treasury.capacity.dlq`

#### Completion Criteria

- [ ] `docker compose config` exits 0
- [ ] Both long-lived services reach `healthy`
- [ ] All three topics exist
- [ ] `.env.example` contains every key declared in `src/config/env.schema.ts`, no more and no fewer
- [ ] No `.env` file was created
- [ ] `docker compose down` then `up -d` again succeeds without error

---

## Final Verification

Run from a clean checkout state with containers down.

1. Dependencies install and the project compiles.
2. Lint passes with the boundary matrix active.
3. The coverage gate fails, proving it is wired.
4. The local stack comes up healthy.
5. The configuration module refuses to boot without required variables.

Commands:

```bash
cd /Users/nd/Work/projects/invoice-reservation

npm install
npm run typecheck          # expect exit 0
npm run lint               # expect exit 0
npm test                   # expect exit 0
npm run test:cov ; echo "COVERAGE_EXIT=$?"   # expect NON-ZERO

docker compose up -d && sleep 30 && docker compose ps
docker compose exec -T redpanda rpk topic list
docker compose down
```

Expected:
- `typecheck`, `lint`, `test` all exit 0
- `COVERAGE_EXIT` is **non-zero** with an unmet-threshold message — this is the Phase 1
  deliverable, not a failure to repair
- Both containers healthy, three topics listed

Do **not** attempt to raise coverage to make `test:cov` pass. Phase 1 ships no testable domain
code; Phase 2's tasks are what move coverage above the floor.

## Executor Rules

1. Execute each task in a **separate sub-agent** with a fresh context; do not run multiple tasks
   inside one long-lived session.
2. Execute tasks strictly in numerical order.
3. Complete the current task and its verification before starting the next task.
4. Implement the solution described in the plan exactly.
5. Do not redesign architecture or substitute a different approach.
6. Do not add features, cleanup, abstractions, or refactors not explicitly required by the plan.
7. Do not omit planned behavior because another implementation appears simpler.
8. Do not reinterpret product requirements.
9. Do not make optional improvements.
10. Follow existing project conventions where the plan explicitly relies on them.
11. Run the verification specified for every task.
12. Mark a task complete only when its completion criteria are satisfied.
13. If implementation reveals information that does not affect the prescribed solution, continue
    execution.
14. Stop rather than improvise when the plan cannot be executed as written.

**Specific to this plan:** `npm run test:cov` failing at the end of Task 4 and at Final
Verification is the intended outcome. An executor that "fixes" it by lowering the threshold,
adding `--passWithNoTests`, excluding `src/` from coverage, or writing filler tests has failed
the task. Report the non-zero exit as success.
