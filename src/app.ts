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
import empAnnouncementsRouter from "./routes/emp-announcements";
import evalsRouter from "./routes/evals";
import type { Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

// ✅ Error handler
app.onError((err, c) => {
    console.error("UNCAUGHT ERROR:", err);
    return c.json(
        { error: "internal_error", detail: (err as any)?.message ?? String(err) },
        500
    );
});

// ✅ Not found
app.notFound((c) => c.json({ error: "not_found" }, 404));

// ✅ CORS
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

// ✅ Health check
app.get("/health", (c) => c.text("ok"));

// ✅ Routes
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
app.route("/emp-announcements", empAnnouncementsRouter);
app.route("/evals", evalsRouter);

// ✅ Static files
app.use("/images/*", serveStatic({ root: "./" }));

// ✅ CORS preflight
app.options("*", (c) => c.body(null, 204));

// ✅ Default export for Cloudflare Worker
export default {
    fetch: (req: Request, env: Bindings, ctx: ExecutionContext) =>
        app.fetch(req, env, ctx),
};
