import { buildApp } from "./app.js";

const app = buildApp({ logger: true, adminApiKey: process.env.ADMIN_API_KEY });

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
