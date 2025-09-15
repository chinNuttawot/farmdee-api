import type { Context, Next } from "hono";
import { getDb } from "../db";
import type { SlimUser } from "../types";

function extractBearerToken(authHeader: string | null | undefined) {
    if (!authHeader) return "";
    const parts = authHeader.split(" ");
    if (parts.length !== 2) return "";
    const [scheme, token] = parts;
    if (scheme.toLowerCase() !== "bearer") return "";
    return (token || "").trim();
}

// ตรวจ Bearer token -> โหลด session + โปรไฟล์ย่อของ user (ยังไม่เช็ค role ที่นี่)
export async function auth(c: Context, next: Next) {
    try {
        const db = getDb((c as any).env);
        const token = extractBearerToken(c.req.header("authorization"));

        if (!token) {
            return c.json({ error: "missing token" }, 401);
        }
        // optional: กัน token แปลกๆ
        if (token.length < 16 || token.length > 2048) {
            return c.json({ error: "invalid token" }, 401);
        }

        // ดึง user ที่สัมพันธ์กับ session ที่ยัง valid ใน SQL เลย
        // หมายเหตุ: ถ้าใช้ Postgres และคอลัมน์ expires_at เป็น timestamptz จะเทียบกับ NOW() ได้ตรงเวลา
        const rows = await db<Pick<SlimUser, "id" | "username" | "email" | "role" | "created_at">>`
      SELECT u.id, u.username, u.email, u.role, u.created_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ${token}
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
      LIMIT 1
    `;

        if (rows.length === 0) {
            // (อาจ) แยกสาเหตุแบบละเอียด ต้อง query เพิ่มเติม แต่โดยทั่วไปพอแล้ว
            return c.json({ error: "invalid or expired token" }, 401);
        }

        const user = rows[0];
        c.set("user", user); // { id, username, email, role, created_at }
        // ถ้าต้องการ set session id/อันอื่น เพิ่ม SELECT column ในด้านบนแล้ว c.set("sessionId", ...)

        await next();
    } catch (e: any) {
        console.error("AUTH ERROR:", e);
        return c.json({ error: "internal", detail: e?.message ?? String(e) }, 500);
    }
}
