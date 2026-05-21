import crypto from "node:crypto";
import os from "node:os";
import { defaultCapabilities, runEdgeRuntime } from "./worker.js";

function resolveCapabilities() {
  const profile = (process.env.EDGE_PROFILE ?? "mobile").toLowerCase();
  if (profile !== "desktop-gpu") {
    return defaultCapabilities;
  }

  const vramRaw = Number(process.env.EDGE_GPU_VRAM_GB ?? 8);
  return {
    charging: true,
    wifi: true,
    idle: true,
    userOptIn: true,
    nodeClass: "desktop_gpu" as const,
    gpu: {
      vendor: process.env.EDGE_GPU_VENDOR ?? "unknown",
      model: process.env.EDGE_GPU_MODEL ?? "desktop-gpu",
      vramGb: Number.isFinite(vramRaw) ? Math.max(1, vramRaw) : 8
    }
  };
}

const config = {
  orchestratorUrl: process.env.ORCHESTRATOR_URL ?? "http://localhost:4000",
  nodeId: process.env.NODE_ID ?? `node-${crypto.randomUUID().slice(0, 8)}`,
  capabilities: resolveCapabilities(),
  adminApiKey: process.env.EDGE_ADMIN_API_KEY,
  agentVersion: process.env.EDGE_AGENT_VERSION ?? "edge-runtime/0.1.0",
  platform: `${os.platform()}-${os.arch()}`,
  idleSleepMs: 5000,
  claimSleepMs: 1500,
  heartbeatIntervalMs: 10_000
};

runEdgeRuntime(config).catch((error) => {
  console.error("[edge-runtime] fatal", error);
  process.exit(1);
});
