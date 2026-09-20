#!/usr/bin/env bash
#
# verify-uat.sh — deterministic UAT verifier for the capacity ledger.
#
# Karst runs this after the AI UAT tester (manifest: `uat.testerVerifier`).
# Exit 0 means the tester's verdict stands; non-zero fails UAT.
#
# It statically encodes, without starting Docker:
#
#   1. TypeScript (strict) compiles.
#   2. ESLint — including the dependency-boundary matrix — passes.
#   3. The Docker-free unit suite passes (test:unit).
#   4. The global coverage gate is wired at 80% for all four counters.
#   5. The two plan.md dependency boundaries are declared and enforced.
#   6. .env.example declares exactly the variables env.schema.ts requires.
#   7. The configuration module refuses to boot without required variables.
#   8. Phase 3 — reserve endpoint, idempotency, POSITION_UNVERIFIED -> 503.
#   9. Phase 4 — release endpoint and policy.
#  10. Phase 5 — availability + reservations reads, audit ledger + scope.
#  11. Phase 6 — cancellation endpoint and policy.
#  12. Phase 7 — treasury consumer, DLQ publisher, stream position, topics.
#  13. Phase 8 — snapshot application service and policy.
#  14. HTTP contract scopes and the POSITION_UNVERIFIED error entry.
#  15. Phase 9 artifacts already landed (reconcile, recovery, perf, job, docs).
#
# It deliberately does not start the docker stack: Karst owns service
# lifecycle, and container bring-up is not a unit of UAT acceptance.
# A final section names everything that cannot be asserted here.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

fail() {
  printf 'verify-uat: FAIL: %s\n' "$*" >&2
  exit 1
}

ok() {
  printf 'verify-uat: ok: %s\n' "$*"
}

# --- 1. TypeScript strict typecheck -----------------------------------------
npm --silent run typecheck >/dev/null 2>&1 || fail "tsc --noEmit exited non-zero"
ok "typecheck"

# --- 2. ESLint with the dependency-boundary matrix --------------------------
npm --silent run lint >/dev/null 2>&1 || fail "eslint . exited non-zero"
ok "lint (including dependency boundaries)"

# --- 3. Unit tests (Docker-free; integration specs use testcontainers) -------
npm --silent run test:unit >/dev/null 2>&1 || fail "jest test/unit exited non-zero"
ok "unit tests"

# --- 4. The coverage gate is live at 80% ------------------------------------
node - <<'NODE' || fail "jest.config.ts does not wire all four global coverage thresholds at 80"
const { readFileSync } = require('fs');
const src = readFileSync('jest.config.ts', 'utf8');
const counters = ['branches', 'functions', 'lines', 'statements'];
const missing = counters.filter((c) => !new RegExp(`${c}\\s*:\\s*80\\b`).test(src));
if (missing.length > 0) {
  console.error(`missing 80% thresholds: ${missing.join(', ')}`);
  process.exit(1);
}
NODE
ok "coverage gate wired at 80% (branches/functions/lines/statements)"

# --- 5. plan.md dependency boundaries enforced ------------------------------
cleanup_probe() {
  rm -f src/shared/__probe_noop.ts \
        src/capacity/infrastructure/__probe_repo.ts \
        src/capacity/domain/__probe_violation.ts \
        src/capacity/domain/__probe_allowed.ts \
        src/treasury/__probe_violation.ts
  rmdir -p src/capacity/domain src/capacity/infrastructure src/shared src/treasury 2>/dev/null || true
}
trap cleanup_probe EXIT

mkdir -p src/shared src/capacity/infrastructure src/capacity/domain src/treasury

cat > src/shared/__probe_noop.ts <<'PROBE'
export const noop = (): void => undefined;
PROBE

cat > src/capacity/infrastructure/__probe_repo.ts <<'PROBE'
export const repo = (): void => undefined;
PROBE

cat > src/capacity/domain/__probe_violation.ts <<'PROBE'
import { repo } from '../infrastructure/__probe_repo';

repo();
PROBE

cat > src/capacity/domain/__probe_allowed.ts <<'PROBE'
import { noop } from '../../shared/__probe_noop';

noop();
PROBE

cat > src/treasury/__probe_violation.ts <<'PROBE'
import { repo } from '../capacity/infrastructure/__probe_repo';

repo();
PROBE

npx eslint src/capacity/domain/__probe_violation.ts >/dev/null \
  && fail "boundary matrix does not reject domain -> infrastructure"
npx eslint src/capacity/domain/__probe_allowed.ts >/dev/null \
  || fail "boundary matrix wrongly rejects domain -> shared"
npx eslint src/treasury/__probe_violation.ts >/dev/null \
  && fail "boundary matrix does not reject treasury -> infrastructure"
ok "dependency boundaries enforced (domain and treasury probes)"

# --- 6. .env.example matches env.schema.ts exactly --------------------------
node - <<'NODE' || fail ".env.example does not declare exactly the env.schema.ts keys"
const { readFileSync } = require('fs');
const schema = readFileSync('src/config/env.schema.ts', 'utf8');
const example = readFileSync('.env.example', 'utf8');
const schemaKeys = new Set([...schema.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1]));
const exampleKeys = new Set([...example.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]));
const onlyExample = [...exampleKeys].filter((k) => !schemaKeys.has(k));
const onlySchema = [...schemaKeys].filter((k) => !exampleKeys.has(k));
if (schemaKeys.size === 0 || onlyExample.length > 0 || onlySchema.length > 0) {
  console.error(`env.schema.ts keys:  ${[...schemaKeys].sort().join(', ')}`);
  console.error(`.env.example keys:    ${[...exampleKeys].sort().join(', ')}`);
  console.error(`only in .env.example: ${onlyExample.join(', ') || '(none)'}`);
  console.error(`only in env.schema.ts: ${onlySchema.join(', ') || '(none)'}`);
  process.exit(1);
}
NODE
ok ".env.example matches env.schema.ts"

# --- 7. Fail-fast configuration ---------------------------------------------
missing_cfg_out="$(env -i PATH="$PATH" HOME="$HOME" npx ts-node src/main.ts 2>&1)"
missing_cfg_rc=$?
if [ "$missing_cfg_rc" -eq 0 ]; then
  fail "the app booted with no configuration (expected a validation failure)"
fi
for key in DATABASE_URL KAFKA_BROKERS KAFKA_SASL_USERNAME KAFKA_SASL_PASSWORD JWT_SECRET; do
  case "$missing_cfg_out" in
    *"$key"*) ;;
    *) fail "startup failure did not name required variable $key" ;;
  esac
done
ok "configuration module fails fast and names every required variable"

# --- 8. Phase 3 — reserve + idempotency -------------------------------------
grep -q "@Post('reservations')" src/capacity/api/capacity.controller.ts \
  || fail "capacity.controller.ts does not declare @Post('reservations')"
grep -q "@RequiredScope('capacity:write')" src/capacity/api/capacity.controller.ts \
  || fail "capacity.controller.ts does not declare @RequiredScope('capacity:write')"
for f in \
  src/capacity/application/reserve.service.ts \
  src/capacity/application/idempotency.service.ts \
  src/capacity/domain/policies/reserve.policy.ts; do
  [ -f "$f" ] || fail "missing phase 3 artifact: $f"
done
grep -q "POSITION_UNVERIFIED" src/capacity/api/error.filter.ts \
  || fail "error.filter.ts does not know POSITION_UNVERIFIED"
grep -q "POSITION_UNVERIFIED: 503" src/capacity/api/error.filter.ts \
  || fail "error.filter.ts does not map POSITION_UNVERIFIED to 503"
grep -q "EXPIRED" src/migrations/1758250000000-AddExpiredRequestState.ts \
  || fail "migration does not add the EXPIRED request_state value"
grep -q "EXPIRED" src/capacity/infrastructure/entities/request-record.entity.ts \
  || fail "request-record.entity.ts does not declare the EXPIRED state"
ok "phase 3 (reserve + idempotency) artifacts present"

# --- 9. Phase 4 — release ---------------------------------------------------
grep -q "@Post('reservations/:invoiceId/releases')" src/capacity/api/capacity.controller.ts \
  || fail "capacity.controller.ts does not declare @Post('reservations/:invoiceId/releases')"
for f in \
  src/capacity/application/release.service.ts \
  src/capacity/domain/policies/release.policy.ts; do
  [ -f "$f" ] || fail "missing phase 4 artifact: $f"
done
ok "phase 4 (release) artifacts present"

# --- 10. Phase 5 — availability + audit reads -------------------------------
grep -q "@Get('availability')" src/capacity/api/capacity.controller.ts \
  || fail "capacity.controller.ts does not declare @Get('availability')"
grep -q "@Get('reservations')" src/capacity/api/capacity.controller.ts \
  || fail "capacity.controller.ts does not declare @Get('reservations')"
grep -q "@Get('ledger')" src/capacity/api/audit.controller.ts \
  || fail "audit.controller.ts does not declare @Get('ledger')"
grep -q "@RequiredScope('capacity:audit')" src/capacity/api/audit.controller.ts \
  || fail "audit.controller.ts does not declare @RequiredScope('capacity:audit')"
[ -f scripts/audit-ledger.ts ] || fail "missing phase 5 artifact: scripts/audit-ledger.ts"
grep -q '"audit:ledger"' package.json \
  || fail "package.json has no audit:ledger script"
ok "phase 5 (availability + audit reads) artifacts present"

# --- 11. Phase 6 — cancel ---------------------------------------------------
grep -q "@Post('reservations/:invoiceId/cancellation')" src/capacity/api/capacity.controller.ts \
  || fail "capacity.controller.ts does not declare @Post('reservations/:invoiceId/cancellation')"
for f in \
  src/capacity/application/cancel.service.ts \
  src/capacity/domain/policies/cancel.policy.ts; do
  [ -f "$f" ] || fail "missing phase 6 artifact: $f"
done
ok "phase 6 (cancel) artifacts present"

# --- 12. Phase 7 — treasury stream ------------------------------------------
for f in \
  src/treasury/consumer/treasury.consumer.ts \
  src/treasury/dlq/dlq.publisher.ts \
  src/capacity/infrastructure/repositories/program-stream-position.repository.ts; do
  [ -f "$f" ] || fail "missing phase 7 artifact: $f"
done
for topic in treasury.capacity.events treasury.capacity.snapshots treasury.capacity.dlq; do
  grep -q "$topic" docker-compose.yml \
    || fail "docker-compose.yml does not name topic $topic"
done
ok "phase 7 (treasury stream) artifacts present"

# --- 13. Phase 8 — snapshots ------------------------------------------------
for f in \
  src/capacity/application/apply-snapshot.service.ts \
  src/capacity/domain/policies/apply-snapshot.policy.ts; do
  [ -f "$f" ] || fail "missing phase 8 artifact: $f"
done
ok "phase 8 (snapshots) artifacts present"

# --- 14. HTTP contract scopes + error mapping -------------------------------
for scope in capacity:read capacity:write capacity:audit; do
  grep -q "x-required-scope: $scope" \
    specs/001-program-capacity-reservation/contracts/http-api.yaml \
    || fail "http-api.yaml does not declare x-required-scope: $scope"
done
grep -qE 'POSITION_UNVERIFIED.*503' \
  specs/001-program-capacity-reservation/contracts/errors.md \
  || fail "contracts/errors.md does not map POSITION_UNVERIFIED to 503"
ok "contract scopes and POSITION_UNVERIFIED (503) documented"

# --- 15. Phase 9 artifacts already landed -----------------------------------
[ -f scripts/reconcile.ts ] || fail "missing phase 9 artifact: scripts/reconcile.ts"
grep -q '"reconcile"' package.json || fail "package.json has no reconcile script"
[ -f test/integration/ledger-recovery.spec.ts ] \
  || fail "missing phase 9 artifact: test/integration/ledger-recovery.spec.ts"
grep -q '"test:recovery"' package.json || fail "package.json has no test:recovery script"
[ -d test/performance ] || fail "missing phase 9 directory: test/performance/"
grep -q '"test:perf"' package.json || fail "package.json has no test:perf script"
[ -f src/capacity/application/reconciliation-check.job.ts ] \
  || fail "missing phase 9 artifact: reconciliation-check.job.ts"
grep -q "RECONCILIATION_INTERVAL_SECONDS" src/config/env.schema.ts \
  || fail "env.schema.ts does not declare RECONCILIATION_INTERVAL_SECONDS"
grep -q "RECONCILIATION_INTERVAL_SECONDS" .env.example \
  || fail ".env.example does not declare RECONCILIATION_INTERVAL_SECONDS"
[ -f docs/ASSUMPTIONS.md ] || fail "missing phase 9 artifact: docs/ASSUMPTIONS.md"
[ -f docs/kafka-acls.md ] || fail "missing phase 9 artifact: docs/kafka-acls.md"
ok "phase 9 artifacts already landed (reconcile/recovery/perf/job/docs)"

# --- Not asserted here (needs Docker or a live stack) ------------------------
printf 'verify-uat: NOT asserted here (require Docker / a live stack):\n'
printf 'verify-uat:   - npm test (integration + contract suites via testcontainers)\n'
printf 'verify-uat:   - npm run test:cov\n'
printf 'verify-uat:   - npm run test:recovery\n'
printf 'verify-uat:   - npm run test:perf\n'
printf 'verify-uat:   - npm run migration:run\n'
printf 'verify-uat:   - npm run seed\n'
printf 'verify-uat:   - npm run audit:ledger\n'
printf 'verify-uat:   - npm run reconcile\n'
printf 'verify-uat:   - docker compose stack health\n'

printf 'verify-uat: PASS\n'
exit 0
