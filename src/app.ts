import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/cloudflare-workers";
import debugRouter from "./routes/debug";
import authRouter from "./routes/auth";
import meRouter from "./routes/me";
import tasksRouter from "./routes/tasks";
import type { Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

// ============ Global error handlers ============
app.onError((err, c) => {
    console.error("UNCAUGHT ERROR:", err);
    return c.json(
        { error: "internal_error", detail: (err as any)?.message ?? String(err) },
        500
    );
});
app.notFound((c) => c.json({ error: "not_found" }, 404));

// ============ CORS ============
app.use(
    "*",
    cors({
        origin: (origin, c) => (c as any).env?.CORS_ALLOW_ORIGIN || origin || "*",
        credentials: false,
        allowHeaders: ["Content-Type", "Authorization"],
        allowMethods: ["GET", "POST", "OPTIONS"],
        maxAge: 86400,
    })
);

// ============ Routes ============
app.route("/", debugRouter);      // /__debug/*, /__db/ping, /health
app.route("/auth", authRouter);   // /auth/*
app.route("/me", meRouter);       // /me
app.route("/tasks", tasksRouter);       // /me


// Static assets (เช่น /images/xxx.png)
app.use("/images/*", serveStatic({ root: "./" }));

export default app;
