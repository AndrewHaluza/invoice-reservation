#!/usr/bin/env bash
#
# verify-uat.sh — deterministic UAT verifier for FEAT-1-PHASE-1-SETUP-SCAFFOLD.
#
# Karst runs this after the AI UAT tester (manifest: `uat.testerVerifier`).
# Exit 0 means the tester's verdict stands; non-zero fails UAT.
#
# It encodes the acceptance criteria of
# docs/plans/2026-09-19-phase-1-setup-scaffold.md:
#
#   1. TypeScript (strict) compiles.
#   2. ESLint — including the dependency-boundary matrix — passes.
#   3. The unit suite passes.
#   4. The global coverage gate is wired at 80% for all four counters.
#   5. The two plan.md dependency boundaries are declared.
#   6. .env.example declares exactly the variables env.schema.ts requires.
#   7. The configuration module refuses to boot without required variables.
#
# It deliberately does not start the docker stack: Karst owns service
# lifecycle, and container bring-up is not a unit of UAT acceptance.

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

# --- 3. Unit tests ----------------------------------------------------------
npm --silent test >/dev/null 2>&1 || fail "jest exited non-zero"
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

# --- 5. plan.md dependency boundaries declared ------------------------------
node - <<'NODE' || fail "eslint.config.mjs is missing the plan.md dependency boundaries"
const { readFileSync } = require('fs');
const src = readFileSync('eslint.config.mjs', 'utf8');
const required = ['element-types', "'domain'", "'treasury'"];
const missing = required.filter((token) => !src.includes(token));
if (missing.length > 0) {
  console.error(`missing boundary config tokens: ${missing.join(', ')}`);
  process.exit(1);
}
NODE
ok "dependency boundaries declared in eslint.config.mjs"

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

printf 'verify-uat: PASS\n'
exit 0
