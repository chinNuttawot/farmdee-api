import { Hono } from "hono";
import { getDb } from "../db";
import { auth } from "../middlewares/auth";
import { responseSuccess, responseError } from "../utils/responseHelper";

const router = new Hono();

/** ===== GET /announcements (list ทั้งหมด) ===== */
router.get("/", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const rows = await db/*sql*/`
      SELECT id, title, content, is_active, created_at, updated_at
      FROM announcements
      ORDER BY created_at DESC
    `;
        return responseSuccess(c, "fetched announcements", rows);
    } catch (err: any) {
        return responseError(c, "internal_error", 500, err?.message ?? String(err));
    }
});

/** ===== POST /announcements (สร้างประกาศใหม่) ===== */
router.post("/", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const body = await c.req.json();
        const { title, content } = body;

        const rows = await db/*sql*/`
      INSERT INTO announcements (title, content)
      VALUES (${title}, ${content})
      RETURNING id, title, content, is_active, created_at
    `;

        return responseSuccess(c, "announcement created", rows[0]);
    } catch (err: any) {
        return responseError(c, "internal_error", 500, err?.message ?? String(err));
    }
});

/** ===== PATCH /announcements/:id/toggle (เปิด/ปิด) ===== */
router.patch("/:id/toggle", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const { id } = c.req.param();

        const rows = await db/*sql*/`
      UPDATE announcements
      SET is_active = NOT is_active
      WHERE id = ${id}::int
      RETURNING id, title, is_active, updated_at
    `;

        if (rows.length === 0) {
            return responseError(c, "not_found", 404, "announcement not found");
        }

        return responseSuccess(c, "announcement toggled", rows[0]);
    } catch (err: any) {
        return responseError(c, "internal_error", 500, err?.message ?? String(err));
    }
});

/** ===== DELETE /announcements/:id (ลบประกาศ) ===== */
router.delete("/:id", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const { id } = c.req.param();

        const rows = await db/*sql*/`
      DELETE FROM announcements
      WHERE id = ${id}::int
      RETURNING id
    `;

        if (rows.length === 0) {
            return responseError(c, "not_found", 404, "announcement not found");
        }

        return responseSuccess(c, "announcement deleted", { id });
    } catch (err: any) {
        return responseError(c, "internal_error", 500, err?.message ?? String(err));
    }
});

/** ===== PATCH /announcements/:id (แก้ไขบางส่วน) ===== */
router.patch("/:id", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const { id } = c.req.param();
        const body = await c.req.json().catch(() => ({}));
        const { title = null, content = null, is_active = null } = body ?? {};

        const rows = await db/*sql*/`
      UPDATE announcements
      SET
        title     = COALESCE(${title}::text, title),
        content   = COALESCE(${content}::text, content),
        is_active = COALESCE(${is_active}::boolean, is_active)
      WHERE id = ${id}::int
      RETURNING id, title, content, is_active, created_at, updated_at
    `;

        if (rows.length === 0) {
            return responseError(c, "not_found", 404, "announcement not found");
        }
        return responseSuccess(c, "announcement updated", rows[0]);
    } catch (err: any) {
        return responseError(c, "internal_error", 500, err?.message ?? String(err));
    }
});
export default router;
