import { Hono } from "hono";
import { getDb } from "../db";

const router = new Hono();

// /__debug/env
router.get("/__debug/env", (c) => {
    const hasNeon = Boolean((c as any).env?.NEON_DATABASE_URL);
    const allow = (c as any).env?.CORS_ALLOW_ORIGIN ?? "(unset)";
    const iter = (c as any).env?.PBKDF2_ITER ?? "(unset)";
    return c.json({
        NEON_DATABASE_URL: hasNeon ? "SET" : "MISSING",
        CORS_ALLOW_ORIGIN: allow,
        PBKDF2_ITER: iter,
    });
});

// /__db/ping
router.get("/__db/ping", async (c) => {
    try {
        const db = getDb((c as any).env);
        const rows = await db`SELECT 1 AS ok`;
        return c.json({ ok: rows?.[0]?.ok === 1 });
    } catch (e: any) {
        console.error("DB PING ERROR:", e);
        return c.json({ error: e?.message ?? String(e) }, 500);
    }
});

// /health
router.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

export default router;
