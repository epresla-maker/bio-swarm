#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-4100}"
ORCHESTRATOR_URL="http://127.0.0.1:${ORCHESTRATOR_PORT}"
ADMIN_API_KEY="${ADMIN_API_KEY:-smoke-admin-key}"
SMOKE_NODE_ID="${SMOKE_NODE_ID:-smoke-node-1}"
ORCH_LOG="${ROOT_DIR}/scripts/.smoke-orchestrator.log"
EDGE_LOG="${ROOT_DIR}/scripts/.smoke-edge.log"
AUDIT_LOG_PATH="${AUDIT_LOG_PATH:-${ROOT_DIR}/scripts/.smoke-audit-log.jsonl}"

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
trap cleanup EXIT

echo "[smoke] building workspace"
pnpm build >/dev/null
rm -f "${AUDIT_LOG_PATH}"

echo "[smoke] starting orchestrator on ${ORCHESTRATOR_URL}"
PORT="${ORCHESTRATOR_PORT}" ADMIN_API_KEY="${ADMIN_API_KEY}" AUDIT_LOG_PATH="${AUDIT_LOG_PATH}" node apps/orchestrator/dist/server.js >"${ORCH_LOG}" 2>&1 &
ORCH_PID=$!

for _ in $(seq 1 40); do
  if curl -fsS "${ORCHESTRATOR_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! curl -fsS "${ORCHESTRATOR_URL}/health" >/dev/null 2>&1; then
  echo "[smoke] orchestrator did not become healthy"
  echo "--- orchestrator log ---"
  cat "${ORCH_LOG}" || true
  exit 1
fi

echo "[smoke] starting edge runtime as ${SMOKE_NODE_ID}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL}" NODE_ID="${SMOKE_NODE_ID}" node packages/edge-runtime/dist/index.js >"${EDGE_LOG}" 2>&1 &
EDGE_PID=$!

echo "[smoke] submitting task"
TASK_JSON="$(curl -fsS -X POST "${ORCHESTRATOR_URL}/tasks" -H "content-type: application/json" -H "x-admin-key: ${ADMIN_API_KEY}" -d '{"kind":"bio_prescreen","payload":{"sample":"smoke-case"},"quorum":1}')"
TASK_ID="$(echo "${TASK_JSON}" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const j=JSON.parse(b);process.stdout.write(j.id||"")});')"

if [[ -z "${TASK_ID}" ]]; then
  echo "[smoke] failed to parse task id"
  echo "${TASK_JSON}"
  exit 1
fi

echo "[smoke] waiting for completion of task ${TASK_ID}"
COMPLETED=0
for _ in $(seq 1 80); do
  TELEMETRY_JSON="$(curl -fsS "${ORCHESTRATOR_URL}/telemetry")"
  COMPLETED="$(echo "${TELEMETRY_JSON}" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const j=JSON.parse(b);process.stdout.write(String(j.queue.completed ?? 0))});')"

  if [[ "${COMPLETED}" -ge 1 ]]; then
    break
  fi

  sleep 0.25
done

TASK_SNAPSHOT="$(curl -fsS "${ORCHESTRATOR_URL}/tasks/${TASK_ID}")"
TASK_STATE="$(echo "${TASK_SNAPSHOT}" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const j=JSON.parse(b);process.stdout.write(String(j.state ?? ""))});')"

TASK_RESULTS="$(curl -fsS "${ORCHESTRATOR_URL}/tasks/${TASK_ID}/results?limit=5")"
TASK_RESULT_COUNT="$(echo "${TASK_RESULTS}" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const j=JSON.parse(b);process.stdout.write(String((j.items ?? []).length))});')"

TASK_VERDICTS="$(curl -fsS "${ORCHESTRATOR_URL}/tasks/${TASK_ID}/verdicts?limit=5")"
TASK_VERDICT_COUNT="$(echo "${TASK_VERDICTS}" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const j=JSON.parse(b);process.stdout.write(String((j.items ?? []).length))});')"

TASK_AUDIT="$(curl -fsS "${ORCHESTRATOR_URL}/tasks/${TASK_ID}/audit?limit=10" -H "x-admin-key: ${ADMIN_API_KEY}")"
TASK_AUDIT_COUNT="$(echo "${TASK_AUDIT}" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const j=JSON.parse(b);process.stdout.write(String((j.items ?? []).length))});')"

NODE_STATS="$(curl -fsS "${ORCHESTRATOR_URL}/nodes/${SMOKE_NODE_ID}/stats")"
ACCEPTED="$(echo "${NODE_STATS}" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const j=JSON.parse(b);process.stdout.write(String(j.accepted ?? 0))});')"
HEARTBEATS="$(echo "${NODE_STATS}" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const j=JSON.parse(b);process.stdout.write(String(j.heartbeats ?? 0))});')"

NODE_SNAPSHOT="$(curl -fsS "${ORCHESTRATOR_URL}/nodes/${SMOKE_NODE_ID}")"
NODE_ACTIVE="$(echo "${NODE_SNAPSHOT}" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const j=JSON.parse(b);process.stdout.write(String(j.active ?? false))});')"

NODE_AUDIT="$(curl -fsS "${ORCHESTRATOR_URL}/nodes/${SMOKE_NODE_ID}/audit?limit=10" -H "x-admin-key: ${ADMIN_API_KEY}")"
NODE_AUDIT_COUNT="$(echo "${NODE_AUDIT}" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const j=JSON.parse(b);process.stdout.write(String((j.items ?? []).length))});')"

if [[ "${COMPLETED}" -lt 1 || "${ACCEPTED}" -lt 1 || "${HEARTBEATS}" -lt 1 || "${TASK_STATE}" != "completed" || "${TASK_RESULT_COUNT}" -lt 1 || "${TASK_VERDICT_COUNT}" -lt 1 || "${TASK_AUDIT_COUNT}" -lt 3 || "${NODE_ACTIVE}" != "true" || "${NODE_AUDIT_COUNT}" -lt 2 ]]; then
  echo "[smoke] verification failed"
  echo "telemetry.completed=${COMPLETED} task.state=${TASK_STATE} task.results=${TASK_RESULT_COUNT} task.verdicts=${TASK_VERDICT_COUNT} task.audit=${TASK_AUDIT_COUNT} node.accepted=${ACCEPTED} node.heartbeats=${HEARTBEATS} node.active=${NODE_ACTIVE} node.audit=${NODE_AUDIT_COUNT}"
  echo "--- orchestrator log ---"
  cat "${ORCH_LOG}" || true
  echo "--- edge log ---"
  cat "${EDGE_LOG}" || true
  exit 1
fi

echo "[smoke] ok: completed=${COMPLETED}, taskState=${TASK_STATE}, accepted=${ACCEPTED}, heartbeats=${HEARTBEATS}, taskAudit=${TASK_AUDIT_COUNT}, nodeAudit=${NODE_AUDIT_COUNT}"
