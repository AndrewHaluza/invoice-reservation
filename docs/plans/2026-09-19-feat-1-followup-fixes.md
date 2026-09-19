# Execution Plan: FEAT-1 follow-up — migrate boundaries API, repair two verification defects

## Goal

Three corrections to work already delivered on the `FEAT-1-PHASE-1-SETUP-SCAFFOLD` branch. The
scaffold itself is correct and **must not be redesigned**. After this plan: `npx eslint .` emits
no deprecation warnings, the UAT verifier proves boundary enforcement by probing it rather than
grepping for a string, and the Phase 1 plan's Redpanda verification command actually works.

## Context for a cold session

You have no memory of the session that produced this. Everything needed is below.

**Repository**: `/Users/nd/Work/projects/invoice-reservation` — a NestJS service implementing a
financing program's capacity ledger. Spec artifacts live under
`specs/001-program-capacity-reservation/`.

**Ticket**: `FEAT-1-PHASE-1-SETUP-SCAFFOLD` (karst id 514), currently in **ship** stage. It
delivered Phase 1: project scaffold, an intentionally-failing 80% Jest coverage gate, an ESLint
dependency-boundary matrix, and a `docker compose` stack (PostgreSQL 16 + SASL Redpanda).

**Worktree you will edit** (two of the three files):
```
/Users/nd/Work/projects/invoice-reservation/.karst/worktrees/feat-1-phase-1-setup-scaffold-scaffold-nestjs-project-with-a
```
on branch `karst/feat/feat-1-phase-1-setup-scaffold-scaffold-nestjs-project-with-a`, based on
`develop`. It has one commit, `a4068df`, and `node_modules/` is installed.

**Main checkout** (the third file): `/Users/nd/Work/projects/invoice-reservation`.

**No PR exists.** `prs: []` in karst; the branch is local only. Opening one is out of scope here.

### What was already verified working — do not "fix" these

A full independent review ran before this plan. All of the following were confirmed by execution,
not by reading:

- `tsc --noEmit`, `eslint .`, `jest` — all exit 0
- `jest --coverage` — **exits 1** at 0% coverage. **This failure is the deliverable of FEAT-1.**
  It is what converts Constitution VI's 80% requirement from an assertion into a build failure.
- All 39 dependency pins match the plan exactly; none carry `^` or `~`
- `.env.example` and `src/config/env.schema.ts` agree exactly, 14 keys each way
- Booting with an empty environment exits 1 naming all five required variables in one message
- Postgres and Redpanda both reach `healthy`; all three topics exist with 3 partitions, RF 1
- `docker compose up -d` is idempotent — `redpanda-init` exits 0 on `TOPIC_ALREADY_EXISTS`
- Both dependency boundaries genuinely reject violating imports (probed with throwaway files)

## Current State

### Defect 1 — deprecated `eslint-plugin-boundaries` API

`eslint.config.mjs` uses `boundaries/element-types` with a `rules:` option. Installed plugin is
`eslint-plugin-boundaries@7.2.0`, where both were renamed. Every lint run prints:

```
[boundaries][warning]: Rule name "boundaries/element-types" is deprecated. Use "boundaries/dependencies" instead.
[boundaries][warning]: [boundaries/element-types] The 'rules' option is deprecated. Please use 'policies' instead.
```

Enforcement still works today; it will break on plugin v8. Eight further tickets (FEAT-2 …
FEAT-9) inherit this config, so the cost of migrating rises with every one.

**The replacement was already tested in the worktree and reverted.** Renaming the rule key to
`boundaries/dependencies` and the `rules:` array to `policies:` — two string changes, nothing
else — removes both warnings, still rejects `domain → infrastructure` and
`treasury → infrastructure` with exit 1, and still permits `domain → shared` with exit 0. The
error message becomes:

```
There is no policy allowing dependencies from elements of type "domain" to elements of type "infrastructure"  boundaries/dependencies
```

### Defect 2 — the UAT verifier greps for the very string Defect 1 removes

`scripts/verify-uat.sh` line ~64:

```js
const required = ['element-types', "'domain'", "'treasury'"];
const missing = required.filter((token) => !src.includes(token));
```

Two problems. It **breaks the moment Defect 1 is fixed**, because `element-types` disappears. And
it was never a real check: a string grep over `eslint.config.mjs` cannot distinguish a working
boundary matrix from a commented-out one. Task 2 replaces it with an executable probe.

### Defect 3 — the Phase 1 plan's Redpanda verification command does not work

`/Users/nd/Work/projects/invoice-reservation/docs/plans/2026-09-19-phase-1-setup-scaffold.md`
tells the verifier to run bare `rpk topic list`. Against this stack that fails:

```
unable to request metadata: broker closed the connection immediately after a request was issued,
which happens when SASL is required but not provided: is SASL missing?
```

The plan assumed `redpanda.enable_sasl=true` bound only the SASL listener on 9093, leaving the
PLAINTEXT listener on 9092 open for `rpk` administration. It is cluster-wide in Redpanda. The
topics are created correctly and the stack is healthy — only the documented command is wrong, so
anyone following it concludes the stack is broken when it is not.

The working form, verified against the running stack:

```bash
docker compose exec -T redpanda rpk topic list \
  -X user=capacity -X pass=capacity_local_dev \
  -X sasl.mechanism=SCRAM-SHA-512 -X brokers=localhost:9093
```

## Target State

- `npx eslint .` exits 0 with **zero** lines containing `deprecated`
- `boundaries/dependencies` rejects the same two imports `boundaries/element-types` rejected
- `scripts/verify-uat.sh` exits 0, and its boundary check fails if enforcement is ever removed
- The Phase 1 plan document carries the SASL-authenticated `rpk` invocation
- `jest --coverage` still exits non-zero — **unchanged and intentional**

## Scope

### In Scope
- `eslint.config.mjs` — two key renames
- `scripts/verify-uat.sh` — replace check 5 with a real probe
- `docs/plans/2026-09-19-phase-1-setup-scaffold.md` — correct two `rpk` commands

### Out of Scope
- The coverage threshold, `collectCoverageFrom`, or anything else in `jest.config.ts`
- Dependency versions — all 39 pins are deliberate and verified
- `docker-compose.yml` — the stack works; only its documentation was wrong
- Adding `src/capacity/`, `src/treasury/`, or any domain code — that is FEAT-2
- Opening, pushing, or merging a PR
- Upgrading NestJS 11 → 12, TypeORM 0.3 → 1.x, or TypeScript 5.6 → 7. Those are pinned to match
  the approved `plan.md`; changing them is a product decision, not a fix.

## Key Decisions

1. **Migrate the boundaries API now rather than pinning the plugin below v8.** Two string changes
   against eight tickets of future inheritance.

2. **Replace the string grep with an executable probe.** The verifier writes throwaway files into
   a temp directory under `src/`, runs ESLint on them, asserts the violating imports exit non-zero
   and the permitted one exits zero, then deletes them. This is the same technique that verified
   the matrix during review. A grep asserts the config *mentions* boundaries; a probe asserts it
   *enforces* them — and enforcement is the thing FEAT-2 onward depends on.

3. **Probe files go under `src/` and are removed in a shell trap.** The `boundaries/include`
   setting is `['src/**/*.ts']`, so files outside `src/` are not evaluated and would make the
   probe vacuously pass. The trap guarantees cleanup even when the script exits early.

## Execution Order

### Task 1: Migrate eslint.config.mjs to the boundaries v7 API

#### Objective

Remove both deprecation warnings while preserving identical enforcement.

#### Files

- `<worktree>/eslint.config.mjs` — modified. Two key renames, nothing else.

where `<worktree>` is
`/Users/nd/Work/projects/invoice-reservation/.karst/worktrees/feat-1-phase-1-setup-scaffold-scaffold-nestjs-project-with-a`

#### Implementation

1. Change the rule key:
   - from: `'boundaries/element-types': [`
   - to:   `'boundaries/dependencies': [`

2. Change the option key inside that rule's config object:
   - from: `          rules: [`
   - to:   `          policies: [`

   This is the array of `{ from, allow }` entries. **Do not confuse it with the outer `rules: {`
   at the ESLint flat-config level, which stays as it is.** The one to change is indented ten
   spaces and sits directly below `default: 'disallow',`.

3. Change nothing else. The ten `{ from, allow }` entries, `default: 'disallow'`,
   `boundaries/no-unknown-files: 'off'`, `settings['boundaries/elements']`,
   `settings['boundaries/include']`, and the `ignores` array all stay byte-identical.

#### Constraints

- Do not add, remove, or reorder any `{ from, allow }` entry. The matrix encodes two rules from
  `specs/001-program-capacity-reservation/plan.md` and both are load-bearing:
  - `domain` allows only `['domain', 'shared']` — the capacity domain imports nothing from
    infrastructure, api, or Kafka.
  - `treasury` allows `['application', 'shared', 'config', 'observability']` and **not**
    `infrastructure` or `domain` — `treasury/` parses, validates, dedupes and dispatches; it never
    writes the capacity aggregate. Without this a second module holds write access to the
    aggregate's internals, and a future change to the position-advance sequence updates one writer
    and silently misses the other.
- Do not change `default: 'disallow'` to `'allow'`.
- Do not upgrade or downgrade `eslint-plugin-boundaries`; 7.2.0 supports the new API.

#### Edge Cases

- If `npx eslint .` reports `Definition for rule 'boundaries/dependencies' was not found`, the
  installed plugin predates the rename. Verify with:
  `node -e "console.log(Object.keys(require('eslint-plugin-boundaries').rules))"`
  It must list `dependencies`. If it does not, **stop and report** — do not revert to
  `element-types` and do not bump the plugin version.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation/.karst/worktrees/feat-1-phase-1-setup-scaffold-scaffold-nestjs-project-with-a

npx eslint . 2>&1 | grep -c deprecated    # expect 0
npx eslint . >/dev/null 2>&1; echo "lint_exit=$?"   # expect 0
```

Expect `0` then `lint_exit=0`.

#### Completion Criteria

- [ ] `eslint.config.mjs` contains `'boundaries/dependencies'` and no `'boundaries/element-types'`
- [ ] It contains `policies: [` and no ten-space-indented `rules: [`
- [ ] All ten `{ from, allow }` entries are unchanged
- [ ] `npx eslint .` exits 0 and prints no line containing `deprecated`

---

### Task 2: Replace the UAT verifier's boundary string-grep with an executable probe

#### Objective

Make check 5 of `verify-uat.sh` prove enforcement instead of asserting a substring — and stop it
failing on Task 1's rename.

#### Files

- `<worktree>/scripts/verify-uat.sh` — modified. Section `# --- 5.` only.

#### Implementation

The current section is:

```bash
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
```

Replace that whole block — from the `# --- 5.` comment line through the `ok "..."` line — with a
probe that:

1. Creates `src/__boundary_probe__/` containing four files:

   - `shared/noop.ts`:
     ```ts
     export const noop = (): void => undefined;
     ```
   - `infra/repo.ts`:
     ```ts
     export const repo = (): void => undefined;
     ```
   - `domain/violation.ts` — imports `repo` from the infra file by relative path and calls it
   - `domain/allowed.ts` — imports `noop` from the shared file by relative path and calls it

   **The probe directory must sit under `src/`**, because `settings['boundaries/include']` is
   `['src/**/*.ts']` and files outside `src/` are not evaluated at all — a probe placed elsewhere
   would pass vacuously.

2. Because `boundaries/elements` patterns are `src/capacity/domain/**`, `src/capacity/infrastructure/**`
   and `src/shared/**`, the probe files must be created at paths those patterns actually match.
   Use exactly:
   - `src/shared/__probe_noop.ts`
   - `src/capacity/infrastructure/__probe_repo.ts`
   - `src/capacity/domain/__probe_violation.ts`
   - `src/capacity/domain/__probe_allowed.ts`

   Create the intermediate directories with `mkdir -p`.

3. Registers a cleanup trap **before** creating anything:
   ```bash
   cleanup_probe() {
     rm -f src/shared/__probe_noop.ts \
           src/capacity/infrastructure/__probe_repo.ts \
           src/capacity/domain/__probe_violation.ts \
           src/capacity/domain/__probe_allowed.ts
     rmdir -p src/capacity/domain src/capacity/infrastructure src/shared 2>/dev/null || true
   }
   trap cleanup_probe EXIT
   ```
   `rmdir -p` removes the directories only when empty, so it cannot delete real source once
   FEAT-2 creates it.

4. Asserts three outcomes, calling the script's existing `fail` helper on any mismatch:
   - `npx eslint src/capacity/domain/__probe_violation.ts` exits **non-zero**
     → else `fail "boundary matrix does not reject domain -> infrastructure"`
   - `npx eslint src/capacity/domain/__probe_allowed.ts` exits **zero**
     → else `fail "boundary matrix wrongly rejects domain -> shared"`
   - A second violation probe for treasury: create
     `src/treasury/__probe_violation.ts` importing from
     `../capacity/infrastructure/__probe_repo`, assert **non-zero**
     → else `fail "boundary matrix does not reject treasury -> infrastructure"`
     Add its path to `cleanup_probe` and add `src/treasury` to the `rmdir -p` list.

5. On success calls `ok "dependency boundaries enforced (domain and treasury probes)"`.

6. Run the probe ESLint invocations with `--no-error-on-unmatched-pattern` omitted and stderr kept,
   so a configuration error surfaces rather than being mistaken for a boundary rejection. A
   non-zero exit caused by a *parse* error would false-pass the violation assertions; guard by
   also asserting the allowed-probe exits zero, which fails loudly if ESLint is broken generally.
   Both assertions together distinguish "rule works" from "ESLint is broken".

#### Constraints

- Do not change checks 1, 2, 3, 4, 6, or 7 in this script.
- Do not remove the script's `set -uo pipefail` or its `cd "$(dirname "$0")/.."`.
- Do not make the probe skip when `src/capacity/` does not exist — it must create what it needs.
- Do not leave probe files behind on any exit path; the trap is mandatory.
- Do not reference the string `element-types` anywhere in the script after this task.

#### Edge Cases

- **FEAT-2 later creates real `src/capacity/domain/` files.** The probe filenames are prefixed
  `__probe_` and deleted individually by name, and `rmdir -p` only removes empty directories, so
  the probe is safe once real source exists.
- **The script runs from the repo root** via its own `cd "$(dirname "$0")/.."`; all probe paths
  above are relative to that root. Do not use absolute paths.
- **ESLint caching**: if a `.eslintcache` exists, a stale entry could mask a probe result. The
  project does not enable caching; if `--cache` is ever added, the probe must pass `--no-cache`.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation/.karst/worktrees/feat-1-phase-1-setup-scaffold-scaffold-nestjs-project-with-a

bash scripts/verify-uat.sh ; echo "uat_exit=$?"

git status --short           # expect EMPTY — no probe files left behind
grep -c element-types scripts/verify-uat.sh   # expect 0
```

Expect `uat_exit=0`, empty `git status`, and `0`.

Then prove the probe actually detects a regression — temporarily widen the matrix and confirm the
verifier fails:

```bash
cp eslint.config.mjs /tmp/eslint.probe-backup.mjs
sed -i '' "s/{ from: 'domain', allow: \['domain', 'shared'\] }/{ from: 'domain', allow: ['domain', 'shared', 'infrastructure'] }/" eslint.config.mjs
bash scripts/verify-uat.sh ; echo "should_be_nonzero=$?"
cp /tmp/eslint.probe-backup.mjs eslint.config.mjs
rm -f /tmp/eslint.probe-backup.mjs
git diff --stat            # expect no diff to eslint.config.mjs
```

`should_be_nonzero` must be **non-zero**. If it is 0, the probe is not actually enforcing and the
task is incomplete.

#### Completion Criteria

- [ ] `bash scripts/verify-uat.sh` exits 0
- [ ] `grep -c element-types scripts/verify-uat.sh` returns 0
- [ ] `git status --short` is empty after a verifier run — no probe files survive
- [ ] Widening the `domain` allow-list makes the verifier exit non-zero
- [ ] `eslint.config.mjs` is byte-identical to its post-Task-1 state after the regression check

---

### Task 3: Correct the Redpanda verification commands in the Phase 1 plan document

#### Objective

Make the documented verification reproducible. Documentation only — no code changes.

#### Files

- `/Users/nd/Work/projects/invoice-reservation/docs/plans/2026-09-19-phase-1-setup-scaffold.md`
  — modified. **This file is in the MAIN checkout, not the worktree.**

#### Implementation

1. In the `### Task 5:` section's `#### Verification` block, replace:
   ```
   docker compose exec -T redpanda rpk topic list
   ```
   with:
   ```
   docker compose exec -T redpanda rpk topic list \
     -X user=capacity -X pass=capacity_local_dev \
     -X sasl.mechanism=SCRAM-SHA-512 -X brokers=localhost:9093
   ```

2. Make the same replacement in the `## Final Verification` section, which carries a second bare
   `rpk topic list`.

3. Immediately below the `#### Implementation` bullet describing the two Redpanda listeners,
   replace the sentence claiming the PLAINTEXT listener leaves `rpk` unauthenticated with:

   > `redpanda.enable_sasl=true` applies cluster-wide, not per listener, so **every** Kafka client
   > must authenticate — including `rpk` run inside the container. The PLAINTEXT listener on 9092
   > remains defined for future tooling, but it is not an unauthenticated administration path.
   > `redpanda-init` creates the SASL user through the admin API on 9644 before any Kafka call,
   > which is why topic creation succeeds.

4. Leave `docker-compose.yml` alone. The stack is correct.

#### Constraints

- Do not edit `docker-compose.yml`, in either the worktree or the main checkout.
- Do not weaken the stack to make the bare command work — removing `enable_sasl` would contradict
  research R11, which requires the authenticated path be the one exercised locally.
- Do not alter any other section of the plan file.

#### Edge Cases

- If the main checkout has uncommitted changes to this file, **stop and report** rather than
  merging edits into unknown work.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation

grep -c "rpk topic list$" docs/plans/2026-09-19-phase-1-setup-scaffold.md   # expect 0
grep -c "sasl.mechanism=SCRAM-SHA-512" docs/plans/2026-09-19-phase-1-setup-scaffold.md  # expect 2
```

Then confirm the corrected command genuinely works against a live stack:

```bash
cd /Users/nd/Work/projects/invoice-reservation/.karst/worktrees/feat-1-phase-1-setup-scaffold-scaffold-nestjs-project-with-a
docker compose up -d
sleep 30
docker compose exec -T redpanda rpk topic list \
  -X user=capacity -X pass=capacity_local_dev \
  -X sasl.mechanism=SCRAM-SHA-512 -X brokers=localhost:9093
docker compose down -v
```

Expect all three of `treasury.capacity.events`, `treasury.capacity.snapshots`,
`treasury.capacity.dlq`, each with 3 partitions and 1 replica.

#### Completion Criteria

- [ ] No bare `rpk topic list` remains in the plan file
- [ ] The SASL-authenticated form appears exactly twice
- [ ] The two-listener explanation states that `enable_sasl` is cluster-wide
- [ ] The corrected command lists all three topics against a running stack
- [ ] `docker-compose.yml` is unmodified in both checkouts

---

## Final Verification

Run from the worktree unless stated otherwise.

```bash
cd /Users/nd/Work/projects/invoice-reservation/.karst/worktrees/feat-1-phase-1-setup-scaffold-scaffold-nestjs-project-with-a

npx eslint . 2>&1 | grep -c deprecated       # expect 0
npm run lint       >/dev/null 2>&1; echo "lint=$?"        # expect 0
npm run typecheck  >/dev/null 2>&1; echo "typecheck=$?"   # expect 0
npm test           >/dev/null 2>&1; echo "test=$?"        # expect 0
npm run test:cov   >/dev/null 2>&1; echo "cov=$?"         # expect 1  <-- MUST stay non-zero
npm run build      >/dev/null 2>&1; echo "build=$?"       # expect 0

bash scripts/verify-uat.sh; echo "uat=$?"    # expect 0
git status --short                            # expect empty
```

Expected: `lint=0`, `typecheck=0`, `test=0`, **`cov=1`**, `build=0`, `uat=0`, clean tree.

`cov=1` is correct and required. Phase 1 ships no testable domain code, so global coverage is 0%
against an 80% floor. **If `cov` becomes 0, something has disabled the coverage gate and this
plan has failed**, regardless of everything else passing.

Then commit in the worktree, on the existing branch, without amending `a4068df`:

```
fix: migrate boundaries API to v7 and make the UAT boundary check executable

eslint-plugin-boundaries 7.2.0 deprecated element-types/rules in favour of
dependencies/policies; the old form warned on every lint run and would break
on v8. Enforcement is unchanged - domain and treasury still cannot reach
infrastructure.

verify-uat.sh check 5 grepped eslint.config.mjs for the literal string
"element-types", so the rename would have broken it. It now writes probe
files, runs ESLint against them, and asserts the violating imports are
rejected and the permitted one is not - which a substring match never did.

The Phase 1 plan's bare `rpk topic list` could not work: enable_sasl is
cluster-wide in Redpanda, not per-listener. Corrected to the authenticated
invocation.
```

Do not push and do not open a PR.

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

**Specific to this plan:**

- `npm run test:cov` **must keep exiting non-zero**. It is the deliverable of FEAT-1, not a
  defect. An executor that raises coverage, lowers the threshold, adds `--passWithNoTests`, or
  narrows `collectCoverageFrom` has failed.
- Do not touch dependency versions. All 39 pins were verified resolvable and deliberately track
  the NestJS 11 line that `plan.md` specifies, even though NestJS 12, TypeORM 1.x and TypeScript 7
  are newer.
- Do not create domain code. `src/capacity/`, `src/treasury/`, `src/shared/` belong to FEAT-2,
  except as transient probe files that Task 2's trap deletes.
