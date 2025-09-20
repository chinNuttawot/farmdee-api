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

const app = new Hono<{ Bindings: Bindings }>();

app.onError((err, c) => {
    console.error("UNCAUGHT ERROR:", err);
    return c.json({ error: "internal_error", detail: (err as any)?.message ?? String(err) }, 500);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

// ✅ CORS สำหรับทุก origin (หรือกำหนดผ่าน ENV)
app.use(
    "*",
    cors({
        origin: (origin, c) => (c as any).env?.CORS_ALLOW_ORIGIN || origin || "*",
        credentials: false, // ถ้าจะส่งคุกกี้ตั้งเป็น true แล้วระบุ origin ให้ชัดเจน
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

// ✅ static (ภาพ/ไฟล์)
app.use("/images/*", serveStatic({ root: "./" }));

// ✅ กันเคสที่ client ยิง OPTIONS มาที่ปลายทางที่ไม่มีเมธอด OPTIONS
app.options("*", (c) => c.body(null, 204));

export default app;
