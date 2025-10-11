import { Hono } from "hono";
import { getDb } from "../db";
import { auth } from "../middlewares/auth";
import { requireRole } from "../middlewares/role";
import { z } from "zod";
import { responseSuccess, responseError } from "../utils/responseHelper";

const router = new Hono();

/** ===== Zod Schemas ===== */
// {
//   "ค่าแรง": "labor",
//   "ค่าอะไหล่": "material",
//   "ค่าน้ำมัน": "fuel",
//   "ค่าโหล่/ค่าขนส่ง": "transport"
// }
const CreateExpenseSchema = z.object({
    title: z.string().min(1),
    type: z.enum(["labor", "material", "fuel", "transport"]),
    amount: z.number().positive(),
    jobNote: z.string().nullable().optional(),
    qtyNote: z.string().nullable().optional(),
    workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
    // หมายเหตุ: payroll_slip_id ไม่เปิดให้ set ตรง ๆ จากภายนอก (ระบบจะจัดการเอง)
});

const UpdateExpenseSchema = CreateExpenseSchema.partial();

/** ===== Routes ===== */

/** GET /expenses?from=YYYY-MM-DD&type=labor|material|fuel|transport */
router.get("/", auth, async (c) => {
    try {
        const db = getDb((c as any).env);

        const q = c.req.query();
        const from = q.from ?? null;
        const type = q.type ?? null;

        const rows = await db/*sql*/`
      SELECT
        e.*,
        u.username AS created_by_username
      FROM expenses e
      JOIN users u ON u.id = e.created_by
      WHERE
        (${from}::date IS NULL OR e.work_date = ${from}::date)
        AND (${type}::text IS NULL OR e.type = ${type}::text)
      ORDER BY e.created_at ASC
    `;

        return responseSuccess(c, "fetched expenses", {
            filters: { from: from ?? null, type: type ?? null },
            count: rows.length,
            items: rows,
        });
    } catch (err: any) {
        console.error("[GET /expenses] error:", err?.message, err?.stack);
        return responseError(c, "internal_error", 500, err?.message ?? String(err));
    }
});

/** POST /expenses (Boss/Admin เท่านั้น) */
router.post("/", auth, requireRole(["boss", "admin"]), async (c) => {
    try {
        const db = getDb((c as any).env);
        const u = c.get("user") as { id: number };

        const body = await c.req.json();
        const parsed = CreateExpenseSchema.safeParse(body);
        if (!parsed.success) {
            return responseError(c, parsed.error.flatten(), 400);
        }

        const { title, type, amount, jobNote, qtyNote, workDate } = parsed.data;

        const rows = await db/*sql*/`
      INSERT INTO expenses
        (title, type, amount, job_note, qty_note, work_date, created_by)
      VALUES
        (${title}::text, ${type}::text, ${amount}::numeric,
         ${jobNote ?? null}::text, ${qtyNote ?? null}::text,
         ${workDate}::date, ${u.id}::int)
      RETURNING *
    `;

        return responseSuccess(c, "expense created", rows[0], 201);
    } catch (err: any) {
        console.error("[POST /expenses] error:", err?.message, err?.stack);
        return responseError(c, "internal_error", 500, err?.message ?? String(err));
    }
});

/** PATCH /expenses/:id (แก้ไขบางฟิลด์ได้, Boss/Admin เท่านั้น) */
router.patch("/:id", auth, requireRole(["boss", "admin"]), async (c) => {
    try {
        const db = getDb((c as any).env);
        const id = Number(c.req.param("id"));
        if (Number.isNaN(id)) return responseError(c, "invalid_id", 400);

        const body = await c.req.json();
        const parsed = UpdateExpenseSchema.safeParse(body);
        if (!parsed.success) {
            return responseError(c, parsed.error.flatten(), 400);
        }

        const { title, type, amount, jobNote, qtyNote, workDate } = parsed.data;

        const rows = await db/*sql*/`
      UPDATE expenses SET
        title     = COALESCE(${title}::text, title),
        type      = COALESCE(${type}::text, type),
        amount    = COALESCE(${amount}::numeric, amount),
        job_note  = COALESCE(${jobNote}::text, job_note),
        qty_note  = COALESCE(${qtyNote}::text, qty_note),
        work_date = COALESCE(${workDate}::date, work_date),
        updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;

        if (rows.length === 0) return responseError(c, "not_found", 404);
        return responseSuccess(c, "expense updated", rows[0]);
    } catch (err: any) {
        console.error("[PATCH /expenses/:id] error:", err?.message, err?.stack);
        return responseError(c, "internal_error", 500, err?.message ?? String(err));
    }
});

/** DELETE /expenses/:id (Boss/Admin เท่านั้น) */
router.delete("/:id", auth, requireRole(["boss", "admin"]), async (c) => {
    try {
        const db = getDb((c as any).env);
        const id = Number(c.req.param("id"));
        if (Number.isNaN(id)) return responseError(c, "invalid_id", 400);

        const rows = await db/*sql*/`
      DELETE FROM expenses
      WHERE id = ${id}
      RETURNING id
    `;

        if (rows.length === 0) return responseError(c, "not_found", 404);
        return responseSuccess(c, "expense deleted", { id });
    } catch (err: any) {
        console.error("[DELETE /expenses/:id] error:", err?.message, err?.stack);
        return responseError(c, "internal_error", 500, err?.message ?? String(err));
    }
});

export default router;
