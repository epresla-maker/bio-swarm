import { buildApp } from "./app.js";
import { configureAuditLogPersistence } from "./store.js";

configureAuditLogPersistence({
  filePath: process.env.AUDIT_LOG_PATH ?? "./data/audit-log.jsonl",
  maxBytes: Number(process.env.AUDIT_LOG_MAX_BYTES ?? 5_000_000),
  maxFiles: Number(process.env.AUDIT_LOG_MAX_FILES ?? 5)
});

const app = buildApp({
  logger: true,
  adminApiKey: process.env.ADMIN_API_KEY,
  adminRateLimitMax: Number(process.env.ADMIN_RATE_LIMIT_MAX ?? 60),
  adminRateLimitWindowMs: Number(process.env.ADMIN_RATE_LIMIT_WINDOW_MS ?? 60_000)
});

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
