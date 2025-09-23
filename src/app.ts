// src/index.ts
import { ExecutionContext, Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/cloudflare-workers";
import debugRouter from "./routes/debug";
import authRouter from "./routes/auth";
import meRouter from "./routes/me";
import expensesRouter from "./routes/expenses";
import tasksRouter from "./routes/tasks";
import usersRouter from "./routes/users";
import payrollsRouter from "./routes/payrolls";
import reportSummaryRouter from "./routes/reports";
import announcementsRouter from "./routes/announcements";
import ruleRouter from "./routes/rule";
import type { Bindings } from "./types";

import { getDb } from "./db";

const app = new Hono<{ Bindings: Bindings }>();

app.onError((err, c) => {
    console.error("UNCAUGHT ERROR:", err);
    return c.json(
        { error: "internal_error", detail: (err as any)?.message ?? String(err) },
        500
    );
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.use(
    "*",
    cors({
        origin: (origin, c) => (c as any).env?.CORS_ALLOW_ORIGIN || origin || "*",
        credentials: false,
        allowHeaders: ["Content-Type", "Authorization"],
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        exposeHeaders: ["Content-Length", "Content-Type"],
        maxAge: 86400,
    })
);

// ✅ healthcheck
app.get("/health", (c) => c.text("ok"));

// ✅ routes
app.route("/", debugRouter);
app.route("/auth", authRouter);
app.route("/me", meRouter);
app.route("/tasks", tasksRouter);
app.route("/expenses", expensesRouter);
app.route("/users", usersRouter);
app.route("/payrolls", payrollsRouter);
app.route("/reports", reportSummaryRouter);
app.route("/announcements", announcementsRouter);
app.route("/rule", ruleRouter);

app.use("/images/*", serveStatic({ root: "./" }));

app.options("*", (c) => c.body(null, 204));

/* ==========================================================
   🔔 Cloudflare Cron Trigger handler (แทน node-cron)
   เวลา: ตั้งใน wrangler.toml เป็น "1 17 * * *" (17:01 UTC = 00:01 ไทย)
   ใช้วันที่ไทยใน SQL: (now() AT TIME ZONE 'Asia/Bangkok')::date
   กติกา:
   - วันนี้(ไทย) > end_date  → status = Done, color = #2E7D32
   - วันนี้(ไทย) = start_date → status = InProgress, color = #2962FF
   ========================================================== */
async function runDailyStatusUpdate(env: Bindings) {
    const db = getDb(env);

    await db/*sql*/`
    UPDATE tasks
    SET status = 'Done',
        color  = '#2E7D32'
    WHERE end_date < (now() AT TIME ZONE 'Asia/Bangkok')::date
      AND status <> 'Done'
  `;

    await db/*sql*/`
    UPDATE tasks
    SET status = 'InProgress',
        color  = '#2962FF'
    WHERE start_date = (now() AT TIME ZONE 'Asia/Bangkok')::date
      AND status NOT IN ('InProgress','Done')
  `;
}

export default {
    fetch: (req: Request, env: Bindings, ctx: ExecutionContext) =>
        app.fetch(req, env, ctx),
    scheduled: async (_event: any, env: Bindings, _ctx: ExecutionContext) => {
        try {
            console.log("🔄 Running daily task status update (cron) ...");
            await runDailyStatusUpdate(env);
            console.log("✅ Daily task status update done.");
        } catch (err) {
            console.error("❌ Cron error:", err);
            throw err;
        }
    },
};