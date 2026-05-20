#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-4000}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://127.0.0.1:${PORT}}"
NODE_ID="${NODE_ID:-dev-node-1}"

ORCH_PID=""
EDGE_PID=""

cleanup() {
  if [[ -n "${EDGE_PID}" ]] && kill -0 "${EDGE_PID}" 2>/dev/null; then
    kill "${EDGE_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${ORCH_PID}" ]] && kill -0 "${ORCH_PID}" 2>/dev/null; then
    kill "${ORCH_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "[dev-stack] starting orchestrator on :${PORT}"
PORT="${PORT}" pnpm --filter @bio-swarm/orchestrator dev &
ORCH_PID=$!

for _ in $(seq 1 80); do
  if curl -fsS "${ORCHESTRATOR_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! curl -fsS "${ORCHESTRATOR_URL}/health" >/dev/null 2>&1; then
  echo "[dev-stack] orchestrator health check failed"
  exit 1
fi

echo "[dev-stack] starting edge runtime as ${NODE_ID}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL}" NODE_ID="${NODE_ID}" pnpm --filter @bio-swarm/edge-runtime dev &
EDGE_PID=$!

echo "[dev-stack] services running. Press Ctrl+C to stop."

wait "$ORCH_PID" "$EDGE_PID"
