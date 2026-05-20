import crypto from "node:crypto";
import { defaultCapabilities, runEdgeRuntime } from "./worker.js";

const config = {
  orchestratorUrl: process.env.ORCHESTRATOR_URL ?? "http://localhost:4000",
  nodeId: process.env.NODE_ID ?? `node-${crypto.randomUUID().slice(0, 8)}`,
  capabilities: defaultCapabilities,
  idleSleepMs: 5000,
  claimSleepMs: 1500,
  heartbeatIntervalMs: 10_000
};

runEdgeRuntime(config).catch((error) => {
  console.error("[edge-runtime] fatal", error);
  process.exit(1);
});
