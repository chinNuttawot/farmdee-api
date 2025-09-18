import { Hono } from "hono";
import { getDb } from "../db";
import { responseSuccess, responseError } from "../utils/responseHelper";

const router = new Hono();

/** GET /__debug/env */
router.get("/__debug/env", (c) => {
    try {
        const env = (c as any).env ?? {};
        const hasNeon = Boolean(env.NEON_DATABASE_URL);
        const allow = (env.CORS_ALLOW_ORIGIN as string | undefined) ?? "(unset)";
        const iter = (env.PBKDF2_ITER as string | number | undefined) ?? "(unset)";

        return responseSuccess(c, "env", {
            NEON_DATABASE_URL: hasNeon ? "SET" : "MISSING",
            CORS_ALLOW_ORIGIN: allow,
            PBKDF2_ITER: iter,
        });
    } catch (e: any) {
        console.error("DEBUG ENV ERROR:", e);
        return responseError(c, "internal", 500, e?.message ?? String(e));
    }
});

/** GET /__db/ping */
router.get("/__db/ping", async (c) => {
    const t0 = Date.now();
    try {
        const db = getDb((c as any).env);
        const rows = await db<{ ok: number }>`SELECT 1 AS ok`;
        const ok = rows?.[0]?.ok === 1;

        return responseSuccess(c, "db ping", {
            ok,
            latencyMs: Date.now() - t0,
        });
    } catch (e: any) {
        console.error("DB PING ERROR:", e);
        return responseError(c, "internal", 500, e?.message ?? String(e));
    }
});

/** GET /health */
router.get("/health", (c) =>
    responseSuccess(c, "healthy", { ts: new Date().toISOString() })
);

export default router;
