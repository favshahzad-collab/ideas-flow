import express from "express";
import helmet from "helmet";
import { prisma } from "./prisma";
import { trustProxySetting } from "./lib/env";
import { jobHealth, jobsHealthy } from "./lib/heartbeat";
import { requestLog } from "./middleware/requestLog";
import { errorHandler } from "./middleware/errorHandler";

import authRoutes from "./routes/auth.routes";
import usersRoutes from "./routes/users.routes";
import adminRoutes from "./routes/admin.routes";
import workflowTemplatesRouter from "./routes/workflow-templates.routes";
import workflowTemplatesPublicRouter from "./routes/workflow-templates.public.routes";
import documentsRouter from "./routes/documents.routes";
import commentsRouter from "./routes/comments.routes";
import workflowRouter from "./routes/workflow.routes";
import auditRouter from "./routes/audit.routes";
import approvalRouter from "./routes/approval.routes";
import notificationsRouter from "./routes/notifications.routes";
import delegationsRouter from "./routes/delegations.routes";
import memoDraftsRouter from "./routes/memoDrafts.routes";

/**
 * The API, assembled but not listening.
 *
 * Separate from `index.ts` so the routes can be exercised without starting a
 * server on a fixed port or connecting a pool that nothing will close - the
 * tests bind an ephemeral port, make real requests, and shut it down again.
 * `index.ts` is now only the part that cannot be tested that way: listening,
 * and dying politely.
 */
const app = express();

/*
 * Who the client is, when something else answered the connection.
 *
 * Off unless `TRUST_PROXY` says otherwise, so a directly exposed API cannot
 * be told its own client's address by that client. Set it and `req.ip` starts
 * meaning the person rather than the proxy - which is what the audit trail
 * records against every approval, and what both sign-in caps count.
 */
app.set("trust proxy", trustProxySetting());

/**
 * The API sent no security headers at all. Defaults are safe here because
 * nothing in this app frames or hot-links an API response — every preview and
 * download is fetched with `fetch` and rendered from a blob URL, so the frame
 * and resource-policy headers cannot affect what the client can display.
 */
/*
 * First, ahead of everything including the body parser: a request that dies
 * in `express.json` because somebody sent broken JSON is exactly the sort
 * that needs an id, and it never reaches a route to acquire one later.
 */
app.use(requestLog);

app.use(helmet());

app.use(express.json({ limit: "5mb" }));

/**
 * Is the process up, and can it still reach the database?
 *
 * Deliberately unauthenticated and cheap: every caller that needs this -
 * a CI job waiting to start the UI, a container healthcheck, a load balancer -
 * asks before anyone has a token. `SELECT 1` is the part worth checking; a
 * process that answers while its connection pool is dead is the failure this
 * catches.
 */
app.get("/api/health", async (_req, res) => {
  let database: "up" | "down" = "up";

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = "down";
  }

  /*
   * The background work, as one word each.
   *
   * Three sweeps run behind this API - the mail outbox, the audit seal, the
   * deadline chase - and until this existed the only sign one had stopped was
   * a line on stdout nobody reads. A stalled mail queue looks exactly like a
   * quiet week.
   *
   * States, never counts: this route has no token and never will, because
   * every caller that needs it - a load balancer, a container healthcheck, a
   * CI job - asks before anyone has one. `ok` / `stalled` / `failing` / `off`
   * tells a monitor everything it can act on and an outsider nothing at all.
   */
  const jobs = jobHealth();
  const healthy = database === "up" && jobsHealthy();

  res
    .status(healthy ? 200 : 503)
    .json({ status: healthy ? "ok" : "degraded", database, jobs });
});

app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/workflow-templates", workflowTemplatesRouter);
app.use("/api/workflow-templates", workflowTemplatesPublicRouter);
app.use("/api/documents", documentsRouter);
app.use("/api", commentsRouter);
app.use("/api", workflowRouter);
app.use("/api", auditRouter);
app.use("/api", approvalRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/delegations", delegationsRouter);
// Mounted at /api because it serves both /api/memo-types and /api/memo-drafts.
app.use("/api", memoDraftsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use(errorHandler);

export default app;
