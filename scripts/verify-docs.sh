#!/usr/bin/env bash
#
# verify-docs.sh — deterministic documentation gate.
#
# It statically encodes, without starting Docker:
#
#   1. TypeScript (strict) compiles.
#   2. The Docker-free documentation unit specs pass.
#   3. README.md exists.
#   4. package.json wires the docs:verify and openapi:export scripts.
#   5. API_DOCS_ENABLED is declared in .env.example and env.schema.ts.
#
# A final section names what this gate cannot assert here.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

fail() {
  printf 'verify-docs: FAIL: %s\n' "$*" >&2
  exit 1
}

ok() {
  printf 'verify-docs: ok: %s\n' "$*"
}

# --- 1. TypeScript strict typecheck -----------------------------------------
npm --silent run typecheck >/dev/null 2>&1 || fail "tsc --noEmit exited non-zero"
ok "typecheck"

# --- 2. Documentation unit specs (Docker-free) ------------------------------
npx jest \
  test/unit/readme-references.spec.ts \
  test/unit/openapi-schemas.spec.ts \
  test/unit/openapi-metadata.spec.ts \
  test/unit/docs-bootstrap.spec.ts \
  test/unit/openapi-validity.spec.ts \
  test/unit/openapi-examples.spec.ts \
  test/unit/openapi-error-codes.spec.ts >/dev/null 2>&1 \
  || fail "documentation unit specs failed"
ok "documentation unit specs"

# --- 3. README exists -------------------------------------------------------
[ -f README.md ] || fail "README.md is missing"
ok "README.md present"

# --- 4. package.json wires the docs scripts ---------------------------------
node - <<'NODE' || fail "package.json scripts are missing docs:verify or openapi:export"
const { readFileSync } = require('fs');
const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
for (const key of ['docs:verify', 'openapi:export']) {
  if (scripts === undefined || !(key in scripts)) {
    console.error(`missing script: ${key}`);
    process.exit(1);
  }
}
NODE
ok "package.json wires docs:verify and openapi:export"

# --- 5. API_DOCS_ENABLED declared everywhere it is needed -------------------
node - <<'NODE' || fail "API_DOCS_ENABLED is not declared in both .env.example and env.schema.ts"
const { readFileSync } = require('fs');
for (const file of ['.env.example', 'src/config/env.schema.ts']) {
  if (!readFileSync(file, 'utf8').includes('API_DOCS_ENABLED')) {
    console.error(`API_DOCS_ENABLED missing from ${file}`);
    process.exit(1);
  }
}
NODE
ok "API_DOCS_ENABLED declared in .env.example and env.schema.ts"

# --- Not asserted here (needs Docker or a live stack) -----------------------
printf 'verify-docs: NOT asserted here (require Docker / a live stack):\n'
printf 'verify-docs:   - test/contract/openapi-conformance.contract.spec.ts\n'

printf 'verify-docs: PASS\n'
exit 0
