import { Hono } from "hono";
import { getDb } from "../db";
import { auth } from "../middlewares/auth";
import { requireRole } from "../middlewares/role";
import { z } from "zod";
import { responseSuccess, responseError } from "../utils/responseHelper";

const router = new Hono();

/** ===== Schemas ===== */
const PreviewSchema = z.object({
    userId: z.number().int().positive(),
    month: z.string().regex(/^\d{4}-\d{2}$/), // YYYY-MM
});

const ComputeSchema = z.object({
    userId: z.number().int().positive(),
    month: z.string().regex(/^\d{4}-\d{2}$/), // YYYY-MM
    deduction: z.number().min(0).default(0), // หักเบิกจาก UI
    note: z.string().optional().nullable(),
});

const ListQuerySchema = z.object({
    userId: z.string().optional(),
    month: z.string().optional(),
    status: z.enum(["Paid", "Unpaid"]).optional(),
});

/** ===== คำนวณจาก tasks + task_assignees (ไม่สร้างตารางใหม่) ===== */
async function computeFromDb(db: any, userId: number, month: string) {
    // รายการรายละเอียด (แสดงในกล่อง "รายละเอียด" ของ UI)
    const details = await db/*sql*/`
    SELECT
      t.id           AS task_id,
      t.title,
      t.job_type,
      t.start_date,
      t.end_date,
      t.area::numeric             AS area,
      ta.rate_per_rai::numeric    AS rate_per_rai,
      ta.repair_rate::numeric     AS repair_rate,
      ta.daily_rate::numeric      AS daily_rate
    FROM tasks t
    JOIN task_assignees ta
      ON ta.task_id = t.id
     AND ta.user_id = ${userId}::int
    WHERE to_char(t.start_date, 'YYYY-MM') = ${month}::text
    ORDER BY t.start_date ASC, t.id ASC
  `;

    // สรุปยอดรวม (ไร่/ซ่อม/รายวัน) จาก details
    let raiQty = 0;
    let raiAmount = 0;
    let repairDays = 0;
    let repairAmount = 0;
    let dailyAmount = 0;

    for (const r of details) {
        const area = r.area == null ? null : Number(r.area);
        const ratePerRai = r.rate_per_rai == null ? null : Number(r.rate_per_rai);
        const repairRate = r.repair_rate == null ? null : Number(r.repair_rate);
        const dailyRate = r.daily_rate == null ? null : Number(r.daily_rate);

        if (area != null && ratePerRai != null) {
            raiQty += area;
            raiAmount += area * ratePerRai;
        }
        if (repairRate != null) {
            repairDays += 1; // นับเป็น 1 วัน/1 งาน
            repairAmount += repairRate;
        }
        if (dailyRate != null) {
            dailyAmount += dailyRate;
        }
    }

    const gross = raiAmount + repairAmount + dailyAmount;

    // แปลง details เป็น array สำหรับ UI
    const lines = details.map((r: any) => {
        const ds = r.start_date?.toISOString?.()
            ? r.start_date.toISOString().slice(0, 10)
            : String(r.start_date);
        const areaTxt = r.area != null ? `${Number(r.area)} ไร่` : "";
        return {
            date: ds,
            taskId: r.task_id,
            title: r.title,
            jobType: r.job_type,
            area: r.area,
            ratePerRai: r.rate_per_rai,
            repairRate: r.repair_rate,
            dailyRate: r.daily_rate,
            display: `${ds} ${r.title}${areaTxt ? " " + areaTxt : ""}`,
        };
    });

    return {
        userId,
        month,
        raiQty: Number(raiQty.toFixed(2)),
        raiAmount: Number(raiAmount.toFixed(2)),
        repairDays,
        repairAmount: Number(repairAmount.toFixed(2)),
        dailyAmount: Number(dailyAmount.toFixed(2)),
        grossAmount: Number(gross.toFixed(2)),
        details: lines,
    };
}

/** ---------- GET /payrolls/preview?userId=&month=YYYY-MM ----------
 * ใช้ก่อนกดบันทึก เพื่อดึงรายละเอียดงาน + สรุปยอด
 */
router.get("/preview", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const q = c.req.query();

        const parsed = PreviewSchema.safeParse({
            userId: q.userId ? Number(q.userId) : undefined,
            month: q.month,
        });
        if (!parsed.success) return responseError(c, parsed.error.flatten(), 400);

        const summary = await computeFromDb(db, parsed.data.userId, parsed.data.month);
        return responseSuccess(c, "payroll preview", summary);
    } catch (e: any) {
        return responseError(c, "internal_error", 500, e?.message ?? String(e));
    }
});

/** ---------- POST /payrolls (บันทึกใบจริงลง payroll_slips) ----------
 * body: { userId, month, deduction, note? }
 * Boss/Admin เท่านั้น
 */
router.post("/", auth, requireRole(["boss", "admin"]), async (c) => {
    try {
        const db = getDb((c as any).env);
        const creator = c.get("user") as { id: number };

        const body = await c.req.json().catch(() => ({}));
        const parsed = ComputeSchema.safeParse(body);
        if (!parsed.success) return responseError(c, parsed.error.flatten(), 400);

        const { userId, month, deduction, note } = parsed.data;

        // กันซ้ำ: เดือนเดียวกัน คนเดียวกัน
        const dup = await db/*sql*/`
      SELECT 1 FROM payroll_slips
      WHERE user_id = ${userId}::int AND month = ${month}::text
      LIMIT 1
    `;
        if (dup.length) return responseError(c, "duplicate_slip", 409, "already exists for this user and month");

        // คำนวณจากฐานข้อมูลจริง
        const summary = await computeFromDb(db, userId, month);
        const gross = summary.grossAmount;
        const net = Math.max(0, gross - deduction);

        // ใช้ transaction สั้น ๆ
        await db/*sql*/`BEGIN`;
        try {
            // ใส่ข้อมูล snapshot
            const ins = await db/*sql*/`
        INSERT INTO payroll_slips (
          user_id, month,
          rai_qty, rai_amount,
          repair_days, repair_amount, daily_amount,
          gross_amount, deduction, net_amount,
          details, note, created_by
        )
        VALUES (
          ${userId}::int, ${month}::text,
          ${summary.raiQty}::numeric, ${summary.raiAmount}::numeric,
          ${summary.repairDays}::int, ${summary.repairAmount}::numeric, ${summary.dailyAmount}::numeric,
          ${gross}::numeric, ${deduction}::numeric, ${net}::numeric,
          ${JSON.stringify(summary.details)}::jsonb, ${note ?? null}::text, ${creator.id}::int
        )
        RETURNING *
      `;
            const slip = ins[0];

            // gen slip_no ด้วย id เพื่อกัน race (เช่น PR-202509-000123)
            const upd = await db/*sql*/`
        UPDATE payroll_slips
        SET slip_no = 'PR-' || replace(${month}::text, '-', '') || '-' || lpad(${slip.id}::text, 6, '0')
        WHERE id = ${slip.id}
        RETURNING *
      `;

            await db/*sql*/`COMMIT`;
            return responseSuccess(c, "payroll created", upd[0], 201);
        } catch (e) {
            await db/*sql*/`ROLLBACK`;
            return responseError(c, "create_failed", 500, (e as any)?.message ?? String(e));
        }
    } catch (e: any) {
        return responseError(c, "internal_error", 500, e?.message ?? String(e));
    }
});

/** ---------- GET /payrolls (ลิสต์ใบจ่าย) ----------
 * รองรับกรอง ?userId=&month=YYYY-MM&status=Paid|Unpaid (ทั้งหมด optional)
 */
router.get("/", auth, async (c) => {
    try {
        const db = getDb((c as any).env);

        const q = c.req.query();
        const parsed = ListQuerySchema.safeParse(q);
        if (!parsed.success) return responseError(c, parsed.error.flatten(), 400);

        const userId = parsed.data.userId ? Number(parsed.data.userId) : null;
        const month = parsed.data.month ?? null;
        const status = parsed.data.status ?? null;

        const rows = await db/*sql*/`
      SELECT p.*, u.username AS employee_username, c.username AS created_by_username
      FROM payroll_slips p
      JOIN users u ON u.id = p.user_id
      JOIN users c ON c.id = p.created_by
      WHERE
        (${userId}::int   IS NULL OR p.user_id = ${userId}::int)
        AND (${month}::text  IS NULL OR p.month = ${month}::text)
        AND (${status}::text IS NULL OR p.status = ${status}::text)
      ORDER BY p.month DESC, p.id DESC
    `;

        return responseSuccess(c, "payroll list", {
            filters: { userId: userId ?? null, month: month ?? null, status: status ?? null },
            count: rows.length,
            items: rows,
        });
    } catch (e: any) {
        return responseError(c, "internal_error", 500, e?.message ?? String(e));
    }
});

/** ---------- GET /payrolls/:id (ดูใบเดี่ยว) ---------- */
router.get("/:id", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const id = Number(c.req.param("id"));
        if (!Number.isInteger(id) || id <= 0) return responseError(c, "invalid id", 400);

        const rows = await db/*sql*/`
      SELECT p.*, u.username AS employee_username, c.username AS created_by_username
      FROM payroll_slips p
      JOIN users u ON u.id = p.user_id
      JOIN users c ON c.id = p.created_by
      WHERE p.id = ${id}
      LIMIT 1
    `;
        if (!rows.length) return responseError(c, "not_found", 404);

        return responseSuccess(c, "payroll", rows[0]);
    } catch (e: any) {
        return responseError(c, "internal_error", 500, e?.message ?? String(e));
    }
});

/** ---------- PATCH /payrolls/:id/pay (เปลี่ยนสถานะจ่าย) ----------
 * body: { paid: boolean }
 */
router.patch("/:id/pay", auth, requireRole(["boss", "admin"]), async (c) => {
    try {
        const db = getDb((c as any).env);
        const id = Number(c.req.param("id"));
        if (!Number.isInteger(id) || id <= 0) return responseError(c, "invalid id", 400);

        const body = await c.req.json().catch(() => ({}));
        const paid = Boolean(body?.paid);

        const rows = await db/*sql*/`
      UPDATE payroll_slips
      SET status = ${paid ? "Paid" : "Unpaid"}::text,
          paid_at = ${paid ? db`now()` : null},
          updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;
        if (!rows.length) return responseError(c, "not_found", 404);

        return responseSuccess(c, "payroll status updated", rows[0]);
    } catch (e: any) {
        return responseError(c, "internal_error", 500, e?.message ?? String(e));
    }
});

/** ---------- DELETE /payrolls/:id (ลบใบ) ----------
 * เผื่อกรณีบันทึกผิด
 */
router.delete("/:id", auth, requireRole(["boss", "admin"]), async (c) => {
    try {
        const db = getDb((c as any).env);
        const id = Number(c.req.param("id"));
        if (!Number.isInteger(id) || id <= 0) return responseError(c, "invalid id", 400);

        const rows = await db/*sql*/`
      DELETE FROM payroll_slips
      WHERE id = ${id}
      RETURNING id
    `;
        if (!rows.length) return responseError(c, "not_found", 404);

        return responseSuccess(c, "payroll deleted", { id: rows[0].id });
    } catch (e: any) {
        return responseError(c, "internal_error", 500, e?.message ?? String(e));
    }
});

export default router;
