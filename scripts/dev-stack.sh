#!/usr/bin/env bash
#
# dev-stack.sh — start the whole service for one Karst ticket, in isolation.
#
# Karst starts a repository's `service.start` command in a terminal whose cwd is
# that ticket's WORKTREE, and exports one env var per declared port slot (see
# `repositories.service.service.ports` in .karst/karst.yml). Everything that
# could collide between two concurrent tickets is derived from those two facts:
#
#   * compose project name  <- the worktree path  (containers, network and the
#                              pgdata volume are all namespaced by it)
#   * every published port  <- the Karst-allocated port slots
#
# So N tickets run N complete, independent stacks at once.
#
# Usage:
#   scripts/dev-stack.sh          start stack + migrations + seed + API (default)
#   scripts/dev-stack.sh up       stack only, no API
#   scripts/dev-stack.sh down     tear this worktree's stack down, volumes included
#   scripts/dev-stack.sh reap     remove stacks whose worktree no longer exists
#   scripts/dev-stack.sh env      print the env this worktree resolves to
#
# Env knobs:
#   KARST_KEEP_STACK=1   do not tear the stack down when the API exits
#   SEED=0               skip `npm run seed`
#   REAP=0               skip the orphan sweep on `up`/`run`

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

require_docker() {
  command -v docker >/dev/null 2>&1 || {
    echo "dev-stack: docker not on PATH" >&2
    exit 2
  }
}

# --- identity ---------------------------------------------------------------
# One compose project per worktree. Lowercased and stripped to [a-z0-9_-], which
# is all compose accepts; the hash of the FULL path keeps two worktrees apart
# after that truncation and stripping.
#
# Deliberately not `:-` defaulted: karst merges the main repository's .env into
# the spawn environment, and a COMPOSE_PROJECT_NAME inherited from there would
# collapse every ticket into one shared stack. The worktree decides this.
WORKTREE_NAME="$(basename "$ROOT")"
WORKTREE_HASH="$(printf '%s' "$ROOT" | shasum | cut -c1-6)"
SLUG="$(printf '%s' "$WORKTREE_NAME" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' | cut -c1-32 | sed 's/-*$//')"
export COMPOSE_PROJECT_NAME="cap-${SLUG}-${WORKTREE_HASH}"

# Stamped onto every container as a label, so `reap` can tell whether the
# worktree a running stack belongs to still exists.
export KARST_WORKTREE="$ROOT"

# --- ports ------------------------------------------------------------------
# Karst exports these; the defaults are the baseline (non-ticket) values so the
# script is still runnable by hand on a clean machine.
export PORT="${PORT:-3000}"
export PG_PORT="${PG_PORT:-5432}"
export REDIS_PORT="${REDIS_PORT:-6379}"
export KAFKA_PORT="${KAFKA_PORT:-9092}"
export KAFKA_SASL_PORT="${KAFKA_SASL_PORT:-9093}"
export REDPANDA_ADMIN_PORT="${REDPANDA_ADMIN_PORT:-9644}"

# --- application configuration ---------------------------------------------
# These four are FUNCTIONS of the ports above, never independent inputs, so they
# are assigned unconditionally. A `:-` default here would let a DATABASE_URL or
# KAFKA_BROKERS inherited from the main repository's .env point this ticket at
# the baseline stack while its own containers sat idle — isolation lost with no
# error anywhere.
export DATABASE_URL="postgres://capacity_app:capacity_local_dev@127.0.0.1:${PG_PORT}/capacity"
export MIGRATION_DATABASE_URL="postgres://capacity:capacity_local_dev@127.0.0.1:${PG_PORT}/capacity"
export REDIS_URL="redis://127.0.0.1:${REDIS_PORT}"
export KAFKA_BROKERS="localhost:${KAFKA_SASL_PORT}"

# Local-dev credentials only; they match docker/postgres-init.sql and the
# redpanda bootstrap in docker-compose.yml. Nothing here is a real secret.
export KAFKA_SASL_USERNAME="${KAFKA_SASL_USERNAME:-capacity}"
export KAFKA_SASL_PASSWORD="${KAFKA_SASL_PASSWORD:-capacity_local_dev}"
export JWT_SECRET="${JWT_SECRET:-local_dev_jwt_secret_change_me_0123456789}"
export NODE_ENV="${NODE_ENV:-development}"

compose() {
  docker compose -f "$ROOT/docker-compose.yml" "$@"
}

print_env() {
  cat <<ENV
COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME
KARST_WORKTREE=$KARST_WORKTREE
PORT=$PORT
PG_PORT=$PG_PORT
REDIS_PORT=$REDIS_PORT
KAFKA_PORT=$KAFKA_PORT
KAFKA_SASL_PORT=$KAFKA_SASL_PORT
REDPANDA_ADMIN_PORT=$REDPANDA_ADMIN_PORT
DATABASE_URL=$DATABASE_URL
REDIS_URL=$REDIS_URL
KAFKA_BROKERS=$KAFKA_BROKERS
ENV
}

stack_down() {
  # -v removes THIS project's volumes only: the pgdata volume is namespaced by
  # COMPOSE_PROJECT_NAME, so no other ticket's database is touched.
  compose down -v --remove-orphans
}

# --- orphan sweep -----------------------------------------------------------
# Karst stops a service by SIGKILLing the process group (runtime/processTree.js
# kills with SIGKILL and no SIGTERM grace phase), and SIGKILL cannot be trapped.
# So the EXIT trap below is best-effort only: a ticket karst stops, or a VS Code
# window that closes, leaves its containers, network, volume and six held ports
# behind. Each `up` therefore sweeps stacks whose worktree directory is gone —
# an absent worktree is unambiguous proof that its stack is dead.
reap_orphans() {
  require_docker
  local line project worktree
  docker ps -a \
    --filter "label=karst.worktree" \
    --format '{{.Label "com.docker.compose.project"}}\t{{.Label "karst.worktree"}}' \
    | sort -u \
    | while IFS=$'\t' read -r project worktree; do
        [ -n "$project" ] && [ -n "$worktree" ] || continue
        [ "$project" = "$COMPOSE_PROJECT_NAME" ] && continue
        [ -d "$worktree" ] && continue
        echo "dev-stack: reaping orphaned stack $project (worktree $worktree is gone)"
        COMPOSE_PROJECT_NAME="$project" docker compose -f "$ROOT/docker-compose.yml" \
          down -v --remove-orphans || true
      done
}

stack_up() {
  require_docker
  [ "${REAP:-1}" = "0" ] || reap_orphans
  echo "dev-stack: project=$COMPOSE_PROJECT_NAME pg=$PG_PORT redis=$REDIS_PORT kafka=$KAFKA_SASL_PORT api=$PORT"
  # --wait blocks until every healthcheck passes. redpanda-init is named
  # separately: it is a one-shot container, and `--wait` treats a container that
  # exits as a failure.
  compose up -d --wait --wait-timeout 180 postgres redis redpanda
  compose run --rm redpanda-init || {
    echo "dev-stack: topic/user bootstrap failed" >&2
    exit 1
  }
  ensure_dependencies
  npm run migration:run
  if [ "${SEED:-1}" != "0" ]; then
    npm run seed
  fi
}

# A fresh worktree has no node_modules of its own — git worktrees share the
# repository, not the install tree. Existence alone is not enough: an install
# interrupted halfway, or a branch that moves package-lock.json, both leave a
# directory that is present and wrong. The stamp records which lockfile the tree
# was built from, and is written only after npm ci succeeds.
ensure_dependencies() {
  local lock_hash stamp
  stamp="$ROOT/node_modules/.dev-stack-lock-hash"
  lock_hash="$(shasum "$ROOT/package-lock.json" | cut -d' ' -f1)"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$lock_hash" ]; then
    return 0
  fi
  echo "dev-stack: installing dependencies (npm ci)"
  npm ci
  printf '%s\n' "$lock_hash" > "$stamp"
}

APP_PID=""

stop_app() {
  # The API is started in the BACKGROUND on purpose: bash runs a trap only once
  # the current foreground command has returned, so with `npm run start:dev` in
  # the foreground a SIGTERM would sit unhandled until the API exited on its own
  # — which, for a watch-mode server, is never. Backgrounding it and waiting
  # makes the trap fire immediately.
  [ -n "$APP_PID" ] || return 0
  kill -TERM "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  APP_PID=""
}

on_exit() {
  stop_app
  stack_down
}

on_signal() {
  # Tear down once, then re-raise with the default handler so the exit code is
  # the conventional 128+n rather than 0.
  trap - EXIT INT TERM HUP
  on_exit
  kill -"$1" $$
}

case "${1:-run}" in
  env)
    print_env
    ;;
  down)
    require_docker
    stack_down
    ;;
  reap)
    reap_orphans
    ;;
  up)
    stack_up
    ;;
  run)
    # Registered BEFORE stack_up: under `set -e` a failure inside it (a bad
    # migration, a failed npm ci, the bootstrap `exit 1`) would otherwise leave
    # the containers it had already started with nothing to clean them up.
    if [ "${KARST_KEEP_STACK:-0}" != "1" ]; then
      trap on_exit EXIT
      trap 'on_signal INT' INT
      trap 'on_signal TERM' TERM
      trap 'on_signal HUP' HUP
    fi
    stack_up
    npm run start:dev &
    APP_PID=$!
    # `wait` is interruptible, so a signal reaches the trap here. It returns
    # >128 when interrupted; that is the signal path, not an API failure, and
    # the trap owns the exit code from there.
    wait "$APP_PID" || true
    ;;
  *)
    echo "dev-stack: unknown command '$1' (env|up|down|reap|run)" >&2
    exit 2
    ;;
esac
