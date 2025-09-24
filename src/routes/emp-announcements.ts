// routes/announcements.ts
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import { auth } from "../middlewares/auth";
import { requireRole } from "../middlewares/role";
import { responseSuccess, responseError } from "../utils/responseHelper";

const router = new Hono();

/** ===== Schemas ===== */
const ListQuerySchema = z.object({
    active: z
        .union([z.literal("true"), z.literal("false")])
        .optional()
        .transform((v) => (typeof v === "string" ? v === "true" : undefined)),
});
const CreateSchema = z.object({
    content: z.string().min(1),
    is_active: z.boolean().default(true),
    sort_order: z.number().int().default(0),
});
const UpdateSchema = z.object({
    id: z.number().int().positive(),
    content: z.string().min(1).optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().optional(),
});
const ParamIdSchema = z.object({
    id: z.coerce.number().int().positive(),
});

/** ===== GET /announcements ===== */
router.get("/", auth, async (c) => {
    try {
        const db = getDb((c as any).env); // NeonQueryFunction
        const url = new URL(c.req.url);
        const q = ListQuerySchema.parse(Object.fromEntries(url.searchParams));

        // Neon ไม่มี query(text, params) ⇒ ต่อ where ด้วย logic แล้วส่ง param ผ่าน ${}
        const rows =
            q.active !== undefined
                ? await db/*sql*/`
            SELECT id, content, is_active, sort_order, created_by, created_at, updated_at
            FROM C_ANNOUNCEMENT
            WHERE is_active = ${q.active}
            ORDER BY sort_order ASC, updated_at DESC
          `
                : await db/*sql*/`
            SELECT id, content, is_active, sort_order, created_by, created_at, updated_at
            FROM C_ANNOUNCEMENT
            WHERE is_active = TRUE
            ORDER BY sort_order ASC, updated_at DESC
          `;

        return responseSuccess(c, "announcement list", {
            filters: { active: q.active ?? true },
            count: rows.length,
            items: rows,
        });
    } catch (err: any) {
        if (err?.issues) return responseError(c, err.issues, 400);
        return responseError(c, "failed", 400, err?.message ?? String(err));
    }
});

/** ===== POST /announcements ===== */
router.post("/", auth, requireRole(["admin", "boss"]), async (c) => {
    try {
        const body = await c.req.json();
        const payload = CreateSchema.parse(body);

        const db = getDb((c as any).env);
        const user = (c.get("user") ?? {}) as { id?: number };
        const createdBy = user?.id ?? null;

        const [created] = await db/*sql*/`
      INSERT INTO C_ANNOUNCEMENT (content, is_active, sort_order, created_by)
      VALUES (${payload.content}, ${payload.is_active}, ${payload.sort_order}, ${createdBy})
      RETURNING id, content, is_active, sort_order, created_by, created_at, updated_at
    `;

        return responseSuccess(c, "announcement created", created, 201);
    } catch (err: any) {
        if (err?.issues) return responseError(c, err.issues, 400);
        return responseError(c, "failed", 400, err?.message ?? String(err));
    }
});

/** ===== PUT /announcements/:id ===== */
router.put("/:id", auth, requireRole(["admin", "boss"]), async (c) => {
    try {
        const { id } = ParamIdSchema.parse(c.req.param());
        const body = await c.req.json();
        const payload = UpdateSchema.parse({ ...body, id });

        const db = getDb((c as any).env);

        // ทำเป็น UPDATE แบบเลือก field; ใน Neon ใช้ CASE/COALESCE ง่ายกว่า
        const [updated] = await db/*sql*/`
      UPDATE C_ANNOUNCEMENT
      SET
        content    = COALESCE(${payload.content}::text, content),
        is_active  = COALESCE(${payload.is_active}::boolean, is_active),
        sort_order = COALESCE(${payload.sort_order}::int, sort_order),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, content, is_active, sort_order, created_by, created_at, updated_at
    `;
        if (!updated) return responseError(c, "not found", 404);

        return responseSuccess(c, "announcement updated", updated);
    } catch (err: any) {
        if (err?.issues) return responseError(c, err.issues, 400);
        return responseError(c, "failed", 400, err?.message ?? String(err));
    }
});

/** ===== DELETE /announcements/:id ===== */
router.delete("/:id", auth, requireRole(["admin", "boss"]), async (c) => {
    try {
        const { id } = ParamIdSchema.parse(c.req.param());
        const db = getDb((c as any).env);

        const rows = await db/*sql*/`
      DELETE FROM C_ANNOUNCEMENT WHERE id = ${id}
      RETURNING id
    `;
        if (rows.length === 0) return responseError(c, "not found", 404);

        return responseSuccess(c, "announcement deleted", { id });
    } catch (err: any) {
        if (err?.issues) return responseError(c, err.issues, 400);
        return responseError(c, "failed", 400, err?.message ?? String(err));
    }
});

export default router;
