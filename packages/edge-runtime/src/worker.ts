import crypto from "node:crypto";
import type { NodeCapabilities, SwarmTask, TaskResult } from "@bio-swarm/shared";

export interface EdgeRuntimeConfig {
  orchestratorUrl: string;
  nodeId: string;
  capabilities: NodeCapabilities;
  idleSleepMs: number;
  claimSleepMs: number;
  heartbeatIntervalMs: number;
}

export interface EdgeRuntimeDeps {
  fetchFn: typeof fetch;
  waitFn: (ms: number) => Promise<void>;
  setIntervalFn: typeof setInterval;
  clearIntervalFn: typeof clearInterval;
  log: Pick<Console, "log" | "error">;
}

export const defaultCapabilities: NodeCapabilities = {
  charging: true,
  wifi: true,
  idle: true,
  userOptIn: true
};

export const defaultDeps: EdgeRuntimeDeps = {
  fetchFn: fetch,
  waitFn: wait,
  setIntervalFn: setInterval,
  clearIntervalFn: clearInterval,
  log: console
};

export function canProcess(input: NodeCapabilities): boolean {
  return input.charging && input.wifi && input.idle && input.userOptIn;
}

export function processTask(task: SwarmTask, nodeId: string): Omit<TaskResult, "taskId" | "submittedAt"> {
  let score = 0;

  switch (task.kind) {
    case "molecule_score":
      score = mockMoleculeScore(task.payload);
      break;
    case "embedding_generate":
      score = mockEmbeddingScore(task.payload);
      break;
    case "bio_prescreen":
      score = 0.6;
      break;
    case "hypothesis_rank":
      score = 0.7;
      break;
    default:
      score = 0.5;
  }

  const checksum = crypto.createHash("sha256").update(JSON.stringify({ task, score })).digest("hex");

  return {
    nodeId,
    checksum,
    score,
    payload: { score }
  };
}

export async function claimTask(
  config: EdgeRuntimeConfig,
  deps: EdgeRuntimeDeps
): Promise<SwarmTask | null> {
  let response: Response;

  try {
    response = await deps.fetchFn(`${config.orchestratorUrl}/tasks/claim?nodeId=${config.nodeId}`);
  } catch (error) {
    deps.log.error("[edge-runtime] claim network error", error);
    return null;
  }

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    deps.log.error("[edge-runtime] claim failed", response.status);
    return null;
  }

  return (await response.json()) as SwarmTask;
}

export async function sendHeartbeat(config: EdgeRuntimeConfig, deps: EdgeRuntimeDeps): Promise<boolean> {
  let response: Response;

  try {
    response = await deps.fetchFn(`${config.orchestratorUrl}/nodes/${config.nodeId}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: config.capabilities })
    });
  } catch (error) {
    deps.log.error("[edge-runtime] heartbeat network error", error);
    return false;
  }

  if (!response.ok) {
    deps.log.error("[edge-runtime] heartbeat failed", response.status);
    return false;
  }

  return true;
}

export async function submitResult(
  config: EdgeRuntimeConfig,
  taskId: string,
  result: Omit<TaskResult, "taskId" | "submittedAt">,
  deps: EdgeRuntimeDeps
): Promise<boolean> {
  let response: Response;

  try {
    response = await deps.fetchFn(`${config.orchestratorUrl}/tasks/${taskId}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result)
    });
  } catch (error) {
    deps.log.error("[edge-runtime] submit network error", error);
    return false;
  }

  if (!response.ok) {
    deps.log.error("[edge-runtime] result submit failed", response.status);
    return false;
  }

  deps.log.log(`[edge-runtime] task ${taskId} submitted with score ${result.score.toFixed(3)}`);
  return true;
}

export function startHeartbeatLoop(config: EdgeRuntimeConfig, deps: EdgeRuntimeDeps): () => void {
  void sendHeartbeat(config, deps);

  const interval = deps.setIntervalFn(() => {
    void sendHeartbeat(config, deps);
  }, config.heartbeatIntervalMs);

  return () => {
    deps.clearIntervalFn(interval);
  };
}

export async function runEdgeRuntime(config: EdgeRuntimeConfig, deps: EdgeRuntimeDeps = defaultDeps): Promise<void> {
  deps.log.log(`[edge-runtime] started as ${config.nodeId}`);
  startHeartbeatLoop(config, deps);

  while (true) {
    if (!canProcess(config.capabilities)) {
      await deps.waitFn(config.idleSleepMs);
      continue;
    }

    const task = await claimTask(config, deps);
    if (!task) {
      await deps.waitFn(config.claimSleepMs);
      continue;
    }

    const result = processTask(task, config.nodeId);
    await submitResult(config, task.id, result, deps);
  }
}

function mockMoleculeScore(payload: Record<string, unknown>): number {
  const seed = JSON.stringify(payload).length;
  return ((seed % 100) + 1) / 100;
}

function mockEmbeddingScore(payload: Record<string, unknown>): number {
  const text = String(payload.text ?? "biomedical");
  return Math.min(0.99, text.length / 100);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}