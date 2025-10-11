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
    const details = await db/*sql*/`
    WITH month_bounds AS (
      SELECT
        to_date(${month} || '-01', 'YYYY-MM-DD') AS d0,
        (to_date(${month} || '-01', 'YYYY-MM-DD') + INTERVAL '1 month')::date AS d1
    )
    SELECT
      t.id                       AS task_id,
      t.title,
      t.job_type,                -- "งานไร่" | "งานซ่อม"
      t.start_date,
      t.end_date,
      t.area::numeric            AS area,
      ta.rate_per_rai::numeric   AS rate_per_rai,
      ta.repair_rate::numeric    AS repair_rate,
      ta.daily_rate::numeric     AS daily_rate,
      u.pay_type::text           AS worker_pay_type -- "daily" | "per_rai" | etc.
    FROM tasks t
    JOIN task_assignees ta
      ON ta.task_id = t.id
     AND ta.user_id = ${userId}::int
    JOIN users u
      ON u.id = ta.user_id
    JOIN month_bounds mb ON TRUE
    WHERE
      t.start_date >= mb.d0 AND t.start_date < mb.d1
      AND (t.end_date IS NULL OR (t.end_date >= mb.d0 AND t.end_date < mb.d1))
    ORDER BY t.start_date ASC, t.id ASC
  `;

    let raiQty = 0;
    let raiAmount = 0;
    let repairDays = 0;
    let repairAmount = 0;
    let dailyAmount = 0;

    for (const r of details) {
        const jobType: string = (r.job_type ?? "").trim();
        const payType: string = (r.worker_pay_type ?? "").trim().toLowerCase();

        const area = r.area == null ? null : Number(r.area);
        const ratePerRai = r.rate_per_rai == null ? null : Number(r.rate_per_rai);
        const repairRate = r.repair_rate == null ? null : Number(r.repair_rate);
        const dailyRate = r.daily_rate == null ? null : Number(r.daily_rate);

        if (payType === "daily") {
            if (dailyRate != null) dailyAmount += dailyRate;
            continue;
        }

        if (jobType === "งานไร่") {
            if (area != null && ratePerRai != null) {
                raiQty += area;
                raiAmount += area * ratePerRai;
            }
        } else if (jobType === "งานซ่อม") {
            if (repairRate != null) {
                repairDays += 1;
                repairAmount += repairRate;
            }
        }
    }

    const gross = raiAmount + repairAmount + dailyAmount;

    const lines = details.map((r: any) => {
        const ds = r.start_date?.toISOString?.()
            ? r.start_date.toISOString().slice(0, 10)
            : String(r.start_date);

        const ed = r.end_date?.toISOString?.()
            ? r.end_date.toISOString().slice(0, 10)
            : r.end_date ? String(r.end_date) : null;

        const asNumber = (v: any) => (v == null ? null : Number(v));
        const areaNum = asNumber(r.area);

        let display: string;
        if ((r.job_type ?? "").trim() === "งานไร่") {
            const areaTxt = areaNum != null ? `${areaNum} ไร่` : "";
            display = `${ds} ${r.title}${areaTxt ? " " + areaTxt : ""}`;
        } else if ((r.job_type ?? "").trim() === "งานซ่อม") {
            display = `${ds} ${r.title}`;
        } else {
            display = `${ds} ${r.title}`;
        }

        return {
            date: ds,
            endDate: ed,
            taskId: r.task_id,
            title: r.title,
            jobType: r.job_type,
            workerPayType: r.worker_pay_type,
            area: r.area,
            ratePerRai: r.rate_per_rai,
            repairRate: r.repair_rate,
            dailyRate: r.daily_rate,
            display,
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

/** ---------- Helpers: expense ↔ slip ---------- */

// คืนข้อมูลสลิป + ชื่อพนักงาน (ไว้ทำ title)
async function getSlipWithUser(db: any, id: number) {
    const rows = await db/*sql*/`
    SELECT
      p.*,
      COALESCE(u.full_name, u.username) AS employee_name
    FROM payroll_slips p
    JOIN users u ON u.id = p.user_id
    WHERE p.id = ${id}::int
    LIMIT 1
  `;
    return rows[0] ?? null;
}

/**
 * สร้าง/อัปเดต expense สำหรับสลิปที่จ่ายแล้ว (idempotent)
 * - type: "labor"
 * - amount: ใช้ net_amount ของสลิป
 * - work_date: ใช้ paid_at::date ถ้ามี (สำรองเป็น now()::date)
 * - title: "ค่าแรง <YYYY-MM> - <ชื่อพนักงาน> (<SLIP_NO>)"
 */
async function upsertExpenseForSlip(db: any, slipId: number, creatorUserId: number) {
    const slip = await getSlipWithUser(db, slipId);
    if (!slip) throw new Error("payroll_not_found");

    const employee = slip.employee_name ?? "ไม่ระบุชื่อ";
    const monthStr = slip.month ?? "-";
    const amountNum = Number(slip.net_amount ?? 0);
    const title = `ค่าแรง ${monthStr} - ${employee}${slip.slip_no ? ` (${slip.slip_no})` : ""}`;

    // หากไม่อนุญาตจ่ายกรณี amount <= 0 ให้ยกเลิกตรงนี้ได้:
    // if (!Number.isFinite(amountNum) || amountNum <= 0) {
    //   throw new Error("invalid_net_amount");
    // }

    await db/*sql*/`
    INSERT INTO expenses (
      title, type, amount, job_note, qty_note, work_date, created_by, payroll_slip_id
    )
    VALUES (
      ${title}::text, 'labor'::text, ${amountNum}::numeric,
      NULL::text, NULL::text,
      COALESCE(${slip.paid_at}::timestamp, now())::date,
      ${creatorUserId}::int, ${slip.id}::int
    )
    ON CONFLICT (payroll_slip_id)
    DO UPDATE SET
      title      = EXCLUDED.title,
      amount     = EXCLUDED.amount,
      work_date  = EXCLUDED.work_date,
      updated_at = now();
  `;
}

/** ลบ expense ที่ผูกกับสลิปนี้ (สำหรับกรณีเปลี่ยนเป็น Unpaid) */
async function deleteExpenseForSlip(db: any, slipId: number) {
    await db/*sql*/`
    DELETE FROM expenses
    WHERE payroll_slip_id = ${slipId}::int
  `;
}

/** ---------- GET /payrolls/preview ---------- */
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
        console.error("[GET /payrolls/preview] error:", e?.message, e?.stack);
        return responseError(c, "internal_error", 500, e?.message ?? String(e));
    }
});

/** ---------- POST /payrolls ---------- */
router.post("/", auth, requireRole(["boss", "admin"]), async (c) => {
    try {
        const db = getDb((c as any).env);
        const creator = c.get("user") as { id: number };

        const body = await c.req.json().catch(() => ({}));
        const parsed = ComputeSchema.safeParse(body);
        if (!parsed.success) return responseError(c, parsed.error.flatten(), 400);

        const { userId, month, deduction, note } = parsed.data;

        const dup = await db/*sql*/`
      SELECT 1 FROM payroll_slips
      WHERE user_id = ${userId}::int AND month = ${month}::text
      LIMIT 1
    `;
        if (dup.length) {
            return responseError(c, "duplicate_slip", 409, "already exists for this user and month");
        }

        const summary = await computeFromDb(db, userId, month);
        const gross = summary.grossAmount;
        const net = Math.max(0, gross - deduction);

        await db/*sql*/`BEGIN`;
        try {
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
            console.error("[POST /payrolls] tx error:", (e as any)?.message, (e as any)?.stack);
            return responseError(c, "create_failed", 500, (e as any)?.message ?? String(e));
        }
    } catch (e: any) {
        console.error("[POST /payrolls] error:", e?.message, e?.stack);
        return responseError(c, "internal_error", 500, e?.message ?? String(e));
    }
});

/** ---------- GET /payrolls ---------- */
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
      SELECT p.*,
             COALESCE(u.full_name, u.username) AS employee_username,
             COALESCE(c.full_name, c.username) AS created_by_username
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
        console.error("[GET /payrolls] error:", e?.message, e?.stack);
        return responseError(c, "internal_error", 500, e?.message ?? String(e));
    }
});

/** ---------- GET /payrolls/:id ---------- */
router.get("/:id", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const id = Number(c.req.param("id"));
        if (!Number.isInteger(id) || id <= 0) return responseError(c, "invalid id", 400);

        const rows = await db/*sql*/`
      SELECT p.*,
             COALESCE(u.full_name, u.username) AS employee_username,
             COALESCE(c.full_name, c.username) AS created_by_username
      FROM payroll_slips p
      JOIN users u ON u.id = p.user_id
      JOIN users c ON c.id = p.created_by
      WHERE p.id = ${id}
      LIMIT 1
    `;
        if (!rows.length) return responseError(c, "not_found", 404);

        return responseSuccess(c, "payroll", rows[0]);
    } catch (e: any) {
        console.error("[GET /payrolls/:id] error:", e?.message, e?.stack);
        return responseError(c, "internal_error", 500, e?.message ?? String(e));
    }
});

/** ---------- PATCH /payrolls/:id/pay ---------- */
router.patch("/:id/pay", auth, requireRole(["boss", "admin"]), async (c) => {
    try {
        const db = getDb((c as any).env);
        const id = Number(c.req.param("id"));
        if (!Number.isInteger(id) || id <= 0) return responseError(c, "invalid id", 400);

        const body = await c.req.json().catch(() => ({}));
        const paid = Boolean(body?.paid);
        const user = c.get("user") as { id: number };

        await db/*sql*/`BEGIN`;
        try {
            // อัปเดตสถานะสลิป + เวลาจ่าย
            const rows = await db/*sql*/`
        UPDATE payroll_slips
        SET status     = ${paid ? "Paid" : "Unpaid"}::text,
            paid_at    = CASE WHEN ${paid}::boolean THEN now() ELSE NULL END,
            updated_at = now()
        WHERE id = ${id}::int
        RETURNING *
      `;
            if (!rows.length) {
                await db/*sql*/`ROLLBACK`;
                return responseError(c, "not_found", 404);
            }

            // จัดการ expense ตามสถานะ
            if (paid) {
                await upsertExpenseForSlip(db, id, user.id);
            } else {
                await deleteExpenseForSlip(db, id);
            }

            await db/*sql*/`COMMIT`;
            return responseSuccess(c, "payroll status updated", rows[0]);
        } catch (e) {
            await db/*sql*/`ROLLBACK`;
            console.error("[PATCH /payrolls/:id/pay] tx error:", (e as any)?.message, (e as any)?.stack);
            return responseError(c, "internal_error", 500, (e as any)?.message ?? String(e));
        }
    } catch (e: any) {
        console.error("[PATCH /payrolls/:id/pay] error:", e?.message, e?.stack);
        return responseError(c, "internal_error", 500, e?.message ?? String(e));
    }
});

/** ---------- DELETE /payrolls/:id ---------- */
router.delete("/:id", auth, requireRole(["boss", "admin"]), async (c) => {
    try {
        const db = getDb((c as any).env);
        const id = Number(c.req.param("id"));
        if (!Number.isInteger(id) || id <= 0) return responseError(c, "invalid id", 400);

        // ไม่ต้องลบ expense เอง หากใช้ FK ON DELETE CASCADE
        const rows = await db/*sql*/`
      DELETE FROM payroll_slips
      WHERE id = ${id}::int
      RETURNING id
    `;
        if (!rows.length) return responseError(c, "not_found", 404);

        return responseSuccess(c, "payroll deleted", { id: rows[0].id });
    } catch (e: any) {
        console.error("[DELETE /payrolls/:id] error:", e?.message, e?.stack);
        return responseError(c, "internal_error", 500, e?.message ?? String(e));
    }
});

export default router;
