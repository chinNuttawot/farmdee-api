import type { Context, Next } from "hono";
import { getDb } from "../db";
import type { SlimUser } from "../types";

// ตรวจ Bearer token -> โหลด session + โปรไฟล์ย่อของ user
export async function auth(c: Context, next: Next) {
    try {
        const db = getDb((c as any).env);
        const authHeader = c.req.header("authorization") || "";
        const token = authHeader.startsWith("Bearer ")
            ? authHeader.slice(7).trim()
            : "";

        if (!token) {
            return c.json({ error: "missing token" }, 401);
        }

        // ตรวจ session
        const rows = await db<{
            user_id: number;
            expires_at: string;
            revoked_at: string | null;
        }>`
      SELECT user_id, expires_at, revoked_at
      FROM sessions
      WHERE token = ${token}
    `;
        if (rows.length === 0) return c.json({ error: "invalid token" }, 401);

        const sess = rows[0];
        if (sess.revoked_at) return c.json({ error: "token revoked" }, 401);

        const now = new Date();
        if (now > new Date(sess.expires_at + "Z")) {
            return c.json({ error: "token expired" }, 401);
        }

        // โหลด user พร้อม role
        const urows = await db<SlimUser>`
      SELECT id, username, email, role, created_at
      FROM users
      WHERE id = ${sess.user_id}
    `;
        if (urows.length === 0) return c.json({ error: "user not found" }, 401);

        // เซ็ต user object ไว้ใน context
        c.set("user", urows[0]);
        await next();
    } catch (e: any) {
        console.error("AUTH ERROR:", e);
        return c.json(
            { error: "internal", detail: e?.message ?? String(e) },
            500
        );
    }
}
