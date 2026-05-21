import crypto from "node:crypto";
import os from "node:os";
import { defaultCapabilities, runEdgeRuntime } from "./worker.js";

const allTaskKinds = [
  "molecule_score",
  "embedding_generate",
  "bio_prescreen",
  "hypothesis_rank",
  "bio_simulation",
  "llm_inference",
  "package_execute"
] as const;

function resolveCapabilities() {
  const profile = (process.env.EDGE_PROFILE ?? "mobile").toLowerCase();
  if (profile !== "desktop-gpu") {
    return defaultCapabilities;
  }

  const vramRaw = Number(process.env.EDGE_GPU_VRAM_GB ?? 8);
  const llmRole = (process.env.EDGE_LLM_ROLE ?? "").trim().toLowerCase();
  const llmModelVersions = (process.env.EDGE_LLM_MODEL_VERSIONS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const llmMaxContextTokensRaw = Number(process.env.EDGE_LLM_MAX_CONTEXT_TOKENS ?? 0);
  const llmConcurrencyRaw = Number(process.env.EDGE_LLM_CONCURRENCY ?? 0);

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
    },
    llm:
      llmRole === "central_host"
        ? {
            role: "central_host" as const,
            modelVersions: llmModelVersions,
            maxContextTokens:
              Number.isFinite(llmMaxContextTokensRaw) && llmMaxContextTokensRaw > 0
                ? Math.floor(llmMaxContextTokensRaw)
                : undefined,
            concurrency:
              Number.isFinite(llmConcurrencyRaw) && llmConcurrencyRaw > 0 ? Math.floor(llmConcurrencyRaw) : undefined
          }
        : undefined
  };
}

const config = {
  orchestratorUrl: process.env.ORCHESTRATOR_URL ?? "http://localhost:4000",
  nodeId: process.env.NODE_ID ?? `node-${crypto.randomUUID().slice(0, 8)}`,
  capabilities: resolveCapabilities(),
  adminApiKey: process.env.EDGE_ADMIN_API_KEY,
  packageSigningKey: process.env.EDGE_PACKAGE_SIGNING_KEY,
  taskSigningKey: process.env.EDGE_TASK_SIGNING_KEY,
  packagePolicyMode: process.env.EDGE_PACKAGE_POLICY_MODE === "relaxed" ? "relaxed" : "strict",
  allowedPackagePermissions: (process.env.EDGE_ALLOWED_PACKAGE_PERMISSIONS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
  agentMode: (["full", "mobile_safe", "package_worker", "llm_central"] as const).includes(
    (process.env.EDGE_AGENT_MODE ?? "full") as "full" | "mobile_safe" | "package_worker" | "llm_central"
  )
    ? ((process.env.EDGE_AGENT_MODE ?? "full") as "full" | "mobile_safe" | "package_worker" | "llm_central")
    : "full",
  allowedTaskKinds: (process.env.EDGE_ALLOWED_TASK_KINDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is (typeof allTaskKinds)[number] => allTaskKinds.includes(item as (typeof allTaskKinds)[number])),
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
