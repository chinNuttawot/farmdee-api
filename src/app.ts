// src/index.ts
import { Hono } from "hono";
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
import cron from "node-cron";
import { Pool } from "pg";

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

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
   🕒 CRON JOB: ทุกวันเวลา 00:01 (โซนเวลาไทย)
   กติกา:
   - วันนี้ > end_date  → status = Done, color = #2E7D32
   - วันนี้ = start_date → status = InProgress, color = #2962FF
   ========================================================== */
cron.schedule(
    "1 0 * * *",
    async () => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(
                `
                    UPDATE tasks
                    SET status = 'Done',
                        color  = '#2E7D32'
                    WHERE end_date < CURRENT_DATE
                    AND status <> 'Done'
                `
            );
            await client.query(
                `
                    UPDATE tasks
                    SET status = 'InProgress',
                        color  = '#2962FF'
                    WHERE start_date = CURRENT_DATE
                    AND status NOT IN ('InProgress', 'Done')
                `
            );
            await client.query("COMMIT");
        } catch (err) {
            await (async () => {
                try {
                    await pool.query("ROLLBACK");
                } catch { }
            })();
        } finally {
            client.release();
        }
    },
    { timezone: "Asia/Bangkok" }
);

export default app;