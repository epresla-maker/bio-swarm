#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-4000}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://127.0.0.1:${PORT}}"
NODE_ID="${NODE_ID:-dev-node-1}"
ADMIN_API_KEY="${ADMIN_API_KEY:-dev-admin-key}"

ORCH_PID=""
EDGE_PID=""

health_ok() {
  curl -fsS "${ORCHESTRATOR_URL}/health" >/dev/null 2>&1
}

cleanup() {
  if [[ -n "${EDGE_PID}" ]] && kill -0 "${EDGE_PID}" 2>/dev/null; then
    kill "${EDGE_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${ORCH_PID}" ]] && kill -0 "${ORCH_PID}" 2>/dev/null; then
    kill "${ORCH_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if health_ok; then
  echo "[dev-stack] reusing existing orchestrator at ${ORCHESTRATOR_URL}"
else
  echo "[dev-stack] starting orchestrator on :${PORT}"
  PORT="${PORT}" ADMIN_API_KEY="${ADMIN_API_KEY}" pnpm --filter @bio-swarm/orchestrator dev &
  ORCH_PID=$!

  for _ in $(seq 1 80); do
    if health_ok; then
      break
    fi
    sleep 0.25
  done

  if ! health_ok; then
    echo "[dev-stack] orchestrator health check failed"
    exit 1
  fi
fi

echo "[dev-stack] starting edge runtime as ${NODE_ID}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL}" NODE_ID="${NODE_ID}" pnpm --filter @bio-swarm/edge-runtime dev &
EDGE_PID=$!

echo "[dev-stack] services running. Press Ctrl+C to stop."
echo "[dev-stack] admin dashboard key: ${ADMIN_API_KEY}"

PIDS=()
if [[ -n "${ORCH_PID}" ]]; then
  PIDS+=("${ORCH_PID}")
fi
if [[ -n "${EDGE_PID}" ]]; then
  PIDS+=("${EDGE_PID}")
fi

wait "${PIDS[@]}"
