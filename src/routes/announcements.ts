import { Hono } from "hono";
import { getDb } from "../db";
import { auth } from "../middlewares/auth";
import { responseSuccess, responseError } from "../utils/responseHelper";

const router = new Hono();

// helper: แปลงบรรทัด + trim ข้อความที่มาจาก client ให้สวยงาม
const normalizeMultiline = (s: unknown) =>
    String(s ?? "")
        .replace(/\r\n/g, "\n") // windows newline
        .replace(/\\n/g, "\n")  // literal "\n" -> newline จริง
        .trim();

const toInt = (v: string | number, def = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : def;
};

/** ===== GET /announcements (list + filters + pagination) =====
 *  query:
 *   - active=true|false (optional)
 *   - page=1.. (default 1)
 *   - limit=10.. (default 50; max 200)
 */
router.get("/", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const q = c.req.query();
        const hasActive = typeof q.active !== "undefined";
        const active = q.active === "true";
        const page = Math.max(1, toInt(q.page ?? 1, 1));
        const limit = Math.min(200, Math.max(1, toInt(q.limit ?? 50, 50)));
        const offset = (page - 1) * limit;

        // นับจำนวน
        const countRows = hasActive
            ? await db/*sql*/`
          SELECT COUNT(*)::int AS count
          FROM announcements
          WHERE is_active = ${active}
        `
            : await db/*sql*/`
          SELECT COUNT(*)::int AS count
          FROM announcements
        `;

        // ดึงรายการ (เรียงล่าสุดก่อน)
        const items = hasActive
            ? await db/*sql*/`
          SELECT id, title, content, is_active, created_at, updated_at
          FROM announcements
          WHERE is_active = ${active}
          ORDER BY updated_at DESC, created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `
            : await db/*sql*/`
          SELECT id, title, content, is_active, created_at, updated_at
          FROM announcements
          ORDER BY updated_at DESC, created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;

        return responseSuccess(c, "fetched announcements", {
            filters: hasActive ? { active } : {},
            page,
            limit,
            count: countRows?.[0]?.count ?? 0,
            items,
        });
    } catch (err: any) {
        return responseError(c, "internal_error", 500, err?.message ?? String(err));
    }
});

/** ===== POST /announcements (สร้างประกาศใหม่) ===== */
router.post("/", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const body = await c.req.json().catch(() => ({}));
        let { title, content, is_active } = body ?? {};

        title = String(title ?? "").trim();
        content = normalizeMultiline(content);
        if (!title || !content) {
            return responseError(c, "bad_request", 400, "title และ content ห้ามว่าง");
        }

        // is_active ไม่มี -> default true
        const active =
            typeof is_active === "boolean"
                ? is_active
                : true;

        const rows = await db/*sql*/`
      INSERT INTO announcements (title, content, is_active)
      VALUES (${title}, ${content}, ${active})
      RETURNING id, title, content, is_active, created_at, updated_at
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
        const id = toInt(c.req.param("id"));
        if (!id) return responseError(c, "bad_request", 400, "invalid id");

        const rows = await db/*sql*/`
      UPDATE announcements
      SET is_active = NOT is_active, updated_at = NOW()
      WHERE id = ${id}
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
        const id = toInt(c.req.param("id"));
        if (!id) return responseError(c, "bad_request", 400, "invalid id");

        const rows = await db/*sql*/`
      DELETE FROM announcements
      WHERE id = ${id}
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
        const id = toInt(c.req.param("id"));
        if (!id) return responseError(c, "bad_request", 400, "invalid id");

        const body = await c.req.json().catch(() => ({}));
        // ถ้ามีการส่งมา ให้ normalize/trim ให้เรียบร้อย
        const title =
            typeof body?.title === "string" ? String(body.title).trim() : null;
        const content =
            typeof body?.content === "string" ? normalizeMultiline(body.content) : null;
        const is_active =
            typeof body?.is_active === "boolean" ? Boolean(body.is_active) : null;

        const rows = await db/*sql*/`
      UPDATE announcements
      SET
        title     = COALESCE(${title}::text, title),
        content   = COALESCE(${content}::text, content),
        is_active = COALESCE(${is_active}::boolean, is_active),
        updated_at = NOW()
      WHERE id = ${id}
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
