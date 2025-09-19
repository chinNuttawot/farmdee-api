import { Hono } from "hono";
import { getDb } from "../db";
import { auth } from "../middlewares/auth";
import { responseSuccess, responseError } from "../utils/responseHelper";

const router = new Hono();

/** ===== GET /users (รายชื่อพนักงาน) ===== */
router.get("/", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const q = c.req.query();
        const role = q.role ?? null;
        // ดึงรายชื่อพนักงานทั้งหมด
        const rows = await db/*sql*/`
      SELECT id, username, email, role, created_at
      FROM users
      WHERE (${role}::text IS NULL OR role = ${role}::text)
      ORDER BY username ASC
    `;

        return responseSuccess(c, "fetched users", {
            count: rows.length,
            items: rows,
        });
    } catch (err: any) {
        return responseError(
            c,
            "internal_error",
            500,
            err?.message ?? String(err)
        );
    }
});

export default router;
