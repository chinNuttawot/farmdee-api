import { Hono } from "hono";
import { getDb } from "../db";
import { hashPassword, verifyPassword, genToken } from "../crypto";
import { LoginSchema, RegisterSchema } from "../schemas/auth";
import { auth } from "../middlewares/auth";
import { getIP, getUA } from "../utils/req";
import { nowPlusDays, toPgTimestamp } from "../utils/time";
import { responseError, responseSuccess } from "../utils/responseHelper";

const router = new Hono();

// POST /auth/register
router.post("/register", async (c) => {
    try {
        const db = getDb((c as any).env);

        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            return responseError(c, "Invalid or missing JSON body", 400);
        }

        const parsed = RegisterSchema.safeParse(body);
        if (!parsed.success) {
            return responseError(c, parsed.error.flatten(), 400);
        }
        const { username, password, email } = parsed.data;

        const exists = await db`SELECT id FROM users WHERE username = ${username}`;
        if (exists.length > 0) {
            return responseError(c, "username already exists", 409);
        }

        const pw = await hashPassword(password);
        const rows = await db<{ id: number }>`
      INSERT INTO users (username, password_hash, email)
      VALUES (${username}, ${pw}, ${email ?? null})
      RETURNING id
    `;

        return responseSuccess(c, "register success", { userId: rows[0].id }, 201);
    } catch (e: any) {
        console.error("REGISTER ERROR:", e);
        return responseError(c, "internal", 500);
    }
});

// POST /auth/login
router.post("/login", async (c) => {
    try {
        const db = getDb((c as any).env);

        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            return responseError(c, "Invalid or missing JSON body", 400);
        }

        const parsed = LoginSchema.safeParse(body);
        if (!parsed.success) {
            return responseError(c, parsed.error.flatten(), 400);
        }
        const { username, password } = parsed.data;

        const rows = await db<{ id: number; password_hash: string }>`
      SELECT id, password_hash FROM users WHERE username = ${username}
    `;
        if (rows.length === 0) return responseError(c, "invalid credentials", 401);

        const user = rows[0];
        const ok = await verifyPassword(password, user.password_hash);
        if (!ok) return responseError(c, "invalid credentials", 401);

        const token = genToken(32);
        const ua = getUA(c);
        const ip = getIP(c);
        const expires = nowPlusDays(7);

        await db`
      INSERT INTO sessions (user_id, token, user_agent, ip, expires_at)
      VALUES (${user.id}, ${token}, ${ua}, ${ip}, ${expires})
    `;

        return responseSuccess(
            c,
            "login success",
            { token, token_type: "Bearer", expires_at: expires },
            200
        );
    } catch (e: any) {
        console.error("LOGIN ERROR:", e);
        return responseError(c, "internal", 500);
    }
});

// POST /auth/logout  (revoke token ปัจจุบัน)
router.post("/logout", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const authHeader = c.req.header("authorization") || "";
        const token = authHeader.slice(7).trim();
        await db`
      UPDATE sessions
      SET revoked_at = ${toPgTimestamp(new Date())}
      WHERE token = ${token}
    `;
        return responseSuccess(c, "logout success");
    } catch (e: any) {
        console.error("LOGOUT ERROR:", e);
        return responseError(c, "internal", 500);
    }
});

// POST /auth/logout-all  (revoke ทุก session ของผู้ใช้)
router.post("/logout-all", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const user = c.get("user") as { id: number };
        await db`
      UPDATE sessions
      SET revoked_at = ${toPgTimestamp(new Date())}
      WHERE user_id = ${user.id} AND revoked_at IS NULL
    `;
        return responseSuccess(c, "logout all success");
    } catch (e: any) {
        console.error("LOGOUT-ALL ERROR:", e);
        return responseError(c, "internal", 500);
    }
});

export default router;
