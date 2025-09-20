import { Hono } from "hono";
import { getDb } from "../db";
import { auth } from "../middlewares/auth";
import { requireRole, isBossOrAdmin } from "../middlewares/role";
import { CreateTaskSchema, UpdateTaskSchema } from "../schemas/task";
import { responseSuccess, responseError } from "../utils/responseHelper";

const router = new Hono();

/** ===== Status rules ===== */
const ALLOWED_STATUS = new Set(["Pending", "InProgress", "Done"]);

// ใช้กับ query filter (?status=Pending|InProgress|All)
function normalizeStatusFilterToken(
  s: string
): "" | "Pending" | "InProgress" | "Done" {
  const v = (s ?? "").trim();
  if (v === "" || v.toLowerCase() === "all") return ""; // All = ไม่กรอง
  if (ALLOWED_STATUS.has(v)) return v as any;
  throw new Error(`invalid status token: "${s}"`);
}

// ใช้กับ body (POST/PATCH)
function normalizeStatusBody(val: unknown): "Pending" | "InProgress" | "Done" {
  const v = String(val ?? "").trim();
  if (ALLOWED_STATUS.has(v)) return v as any;
  throw new Error(`status must be one of: Pending | InProgress | Done`);
}

/** -------- helpers -------- */
async function upsertAssignees(db: any, taskId: number, list: any[]) {
  for (const cfg of list) {
    // หาตาม id หรือ username
    let uid = cfg.userId as number | undefined;
    if (!uid && cfg.username) {
      const urow = await db<{ id: number }>`
        SELECT id FROM users WHERE username = ${cfg.username}::text LIMIT 1
      `;
      uid = urow[0]?.id;
    }
    if (!uid) continue;

    // ถ้า useDefault === true -> null ค่า custom ทั้งหมด
    const useDefault = cfg.useDefault !== false; // default = true
    const ratePerRai = useDefault ? null : cfg.ratePerRai ?? null;
    const repairRate = useDefault ? null : cfg.repairRate ?? null;
    const dailyRate = useDefault ? null : cfg.dailyRate ?? null;

    await db/*sql*/`
      INSERT INTO task_assignees (
        task_id, user_id, use_default,
        rate_per_rai, repair_rate, daily_rate
      ) VALUES (
        ${taskId}::int, ${uid}::int, ${useDefault}::boolean,
        ${ratePerRai}::numeric, ${repairRate}::numeric, ${dailyRate}::numeric
      )
      ON CONFLICT (task_id, user_id) DO UPDATE SET
        use_default  = EXCLUDED.use_default,
        rate_per_rai = EXCLUDED.rate_per_rai,
        repair_rate  = EXCLUDED.repair_rate,
        daily_rate   = EXCLUDED.daily_rate
    `;
  }
}

/** คืน JSON ของ assignees ด้วย taskId (ใช้ตอนที่ไม่มีตาราง t ให้ join) */
async function fetchAssigneesJson(db: any, taskId: number) {
  const rows = await db/*sql*/`
    SELECT
      COALESCE(
        json_agg(
          json_build_object(
            'id', v.user_id,
            'username', v.username,
            'payType', v.pay_type,
            'useDefault', v.use_default,
            'ratePerRai', v.eff_rate_per_rai,
            'repairRate', v.eff_repair_rate,
            'dailyRate', v.eff_daily_rate
          )
          ORDER BY v.username
        ),
        '[]'::json
      ) AS assignees
    FROM v_task_assignees_effective v
    WHERE v.task_id = ${taskId}::int
  `;
  return rows[0]?.assignees ?? [];
}

/** -------- GET /tasks -------- */
router.get("/", auth, async (c) => {
  try {
    const db = getDb((c as any).env);
    const q = c.req.query();

    // ----- รับพารามิเตอร์ -----
    const fromParam = q.from ?? null; // YYYY-MM-DD -> t.start_date = from
    const toParam = q.to ?? null; // YYYY-MM-DD -> t.end_date = to

    // รองรับหลายสถานะ: ?status=Pending|InProgress|Done  และ All/ว่าง = ไม่กรอง
    let statusArr: string[] = [];
    let hasStatus = false;
    try {
      const raw = String(q.status ?? "");
      const tokens = raw.split("|").map((s) => s.trim()).filter(Boolean);
      const normalized = tokens
        .map((t) => normalizeStatusFilterToken(t))
        .filter((t) => t !== ""); // ตัด All ออก
      statusArr = normalized;
      hasStatus = statusArr.length > 0;
    } catch (e) {
      return responseError(c, "invalid_status", 400, (e as Error).message);
    }

    // ----- ดึงงาน (ทุก user เหมือนกัน) -----
    const rows = await db/*sql*/`
      SELECT
          t.id,
          TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM t.area::text))::numeric AS area,
          t.title,
          t.job_type,
          t.start_date,
          t.end_date,
          t.trucks,
          t.total_amount,
          t.paid_amount,
          t.note,
          t.status,
          t.color,
          t.tags,
          t.progress,
          t.created_by,
          t.created_at,
        COALESCE(a.assignees, '[]'::json) AS assignees
      FROM tasks t
      LEFT JOIN LATERAL (
        SELECT
          json_agg(
            json_build_object(
              'id', v.user_id,
              'username', v.username,
              'payType', v.pay_type,
              'useDefault', v.use_default,
              'ratePerRai', v.eff_rate_per_rai,
              'repairRate', v.eff_repair_rate,
              'dailyRate', v.eff_daily_rate
            )
            ORDER BY v.username
          ) AS assignees
        FROM v_task_assignees_effective v
        WHERE v.task_id = t.id
      ) a ON TRUE
      WHERE
        ( ${fromParam}::date   IS NULL OR t.start_date = ${fromParam}::date )
        AND ( ${toParam}::date IS NULL OR t.end_date   = ${toParam}::date )
        AND ( ${hasStatus}::boolean IS FALSE OR t.status = ANY(${statusArr}::text[]) )
      ORDER BY t.start_date ASC, t.id ASC
    `;

    return responseSuccess(c, "tasks", {
      filters: { from: fromParam ?? null, to: toParam ?? null, status: hasStatus ? statusArr : [] },
      count: rows.length,
      items: rows,
    });
  } catch (e: any) {
    console.error("GET /tasks ERROR:", e);
    return responseError(c, "internal", 500, e?.message ?? String(e));
  }
});

/** -------- GET /tasks/:id -------- */
router.get("/:id", auth, async (c) => {
  try {
    const db = getDb((c as any).env);
    const id = Number(c.req.param("id"));

    const rows = await db/*sql*/`
      SELECT
        t.*,
        COALESCE(a.assignees, '[]'::json) AS assignees
      FROM tasks t
      LEFT JOIN LATERAL (
        SELECT
          json_agg(
            json_build_object(
              'id', v.user_id,
              'username', v.username,
              'payType', v.pay_type,
              'useDefault', v.use_default,
              'ratePerRai', v.eff_rate_per_rai,
              'repairRate', v.eff_repair_rate,
              'dailyRate', v.eff_daily_rate
            )
            ORDER BY v.username
          ) AS assignees
        FROM v_task_assignees_effective v
        WHERE v.task_id = t.id
      ) a ON TRUE
      WHERE t.id = ${id}
      LIMIT 1
    `;
    if (!rows.length) return responseError(c, "not_found", 404);

    return responseSuccess(c, "task", { item: rows[0] });
  } catch (e: any) {
    console.error("GET /tasks/:id ERROR:", e);
    return responseError(c, "internal", 500, e?.message ?? String(e));
  }
});

/** -------- POST /tasks (boss/admin) -------- */
router.post("/", auth, requireRole(["boss", "admin"]), async (c) => {
  try {
    const db = getDb((c as any).env);
    const creator = c.get("user") as { id: number };

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return responseError(c, "Invalid JSON", 400);
    }
    const parsed = CreateTaskSchema.safeParse(body);
    if (!parsed.success) return responseError(c, parsed.error.flatten(), 400);
    const d: any = parsed.data;

    // status: ถ้าไม่ส่งมา -> Default 'Pending', ถ้าส่งมา validate ให้รับเฉพาะ 3 ค่า
    let bodyStatus = "Pending";
    try {
      bodyStatus = d.status == null ? "Pending" : normalizeStatusBody(d.status);
    } catch (e) {
      return responseError(c, "invalid_status", 400, (e as Error).message);
    }

    const trow = await db<{ id: number }>`
      INSERT INTO tasks (
        title, job_type, start_date, end_date, area, trucks,
        total_amount, paid_amount, note, status, color, tags, progress, created_by
      ) VALUES (
        ${d.title}::text,
        ${d.jobType}::text,
        ${d.startDate}::date,
        ${d.endDate}::date,
        ${d.area ?? null}::numeric,
        ${d.trucks ?? null}::int,
        ${d.totalAmount ?? 0}::int,
        ${d.paidAmount ?? 0}::int,
        ${d.note ?? null}::text,
        ${bodyStatus}::text,
        ${d.color ?? null}::text,
        ${d.tags ?? []}::text[],
        ${0.0}::numeric(3,1),
        ${creator.id}::int
      )
      RETURNING id
    `;
    const taskId = trow[0].id;

    if (Array.isArray(d.assigneeConfigs) && d.assigneeConfigs.length > 0) {
      await upsertAssignees(db, taskId, d.assigneeConfigs);
    } else {
      if (Array.isArray(d.assigneeIds) && d.assigneeIds.length > 0) {
        for (const uid of d.assigneeIds) {
          await db/*sql*/`
            INSERT INTO task_assignees (task_id, user_id, use_default)
            VALUES (${taskId}::int, ${uid}::int, true)
            ON CONFLICT DO NOTHING
          `;
        }
      } else if (Array.isArray(d.assigneeUsernames) && d.assigneeUsernames.length > 0) {
        const urows = await db<{ id: number }>`
          SELECT id FROM users WHERE username = ANY(${d.assigneeUsernames}::text[])
        `;
        for (const u2 of urows) {
          await db/*sql*/`
            INSERT INTO task_assignees (task_id, user_id, use_default)
            VALUES (${taskId}::int, ${u2.id}::int, true)
            ON CONFLICT DO NOTHING
          `;
        }
      }
    }

    return responseSuccess(c, "created", { id: taskId }, 201);
  } catch (e: any) {
    console.error("POST /tasks ERROR:", e);
    return responseError(c, "internal", 500, e?.message ?? String(e));
  }
});

/** -------- PATCH /tasks/:id -------- */
router.patch("/:id", auth, async (c) => {
  try {
    const db = getDb((c as any).env);
    const u = c.get("user") as { id: number; role?: string };
    const id = Number(c.req.param("id"));

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return responseError(c, "Invalid JSON", 400);
    }
    const parsed = UpdateTaskSchema.safeParse(body);
    if (!parsed.success) return responseError(c, parsed.error.flatten(), 400);
    const d: any = parsed.data;

    const can = isBossOrAdmin(u)
      ? await db`SELECT 1 FROM tasks WHERE id = ${id} LIMIT 1`
      : await db/*sql*/`
          SELECT 1
          FROM tasks t
          JOIN task_assignees ta_v
            ON ta_v.task_id = t.id
           AND ta_v.user_id = ${u.id}
          WHERE t.id = ${id}
          LIMIT 1
        `;
    if (!can.length) return responseError(c, "forbidden", 403);

    const admin = isBossOrAdmin(u);

    if (!admin) {
      const progressVal = d.progress ?? null;
      const noteVal = d.note ?? undefined;

      const updated = await db/*sql*/`
        UPDATE tasks SET
          progress = CASE
            WHEN (${progressVal}::numeric(3,1)) IS NULL THEN progress
            ELSE GREATEST(0.0::numeric(3,1),
                          LEAST(1.0::numeric(3,1), (${progressVal})::numeric(3,1)))
          END,
          note = COALESCE(${noteVal}::text, note)
        WHERE id = ${id}
        RETURNING *
      `;
      if (!updated.length) return responseError(c, "not_found", 404);

      const assignees = await fetchAssigneesJson(db, id);
      return responseSuccess(c, "updated", { task: { ...updated[0], assignees } });
    }

    const titleVal = d.title ?? null;
    const jobTypeVal = d.jobType ?? null;
    const startDateVal = d.startDate ?? null;
    const endDateVal = d.endDate ?? null;
    const areaVal = d.area ?? null;
    const trucksVal = d.trucks ?? null;

    // status (optional) — validate ถ้าส่งมา
    let statusVal: string | null = null;
    try {
      statusVal = d.status == null ? null : normalizeStatusBody(d.status);
    } catch (e) {
      return responseError(c, "invalid_status", 400, (e as Error).message);
    }

    const colorVal = d.color ?? null;
    const tagsVal = d.tags ?? null;

    const progressVal = d.progress ?? null;
    const noteVal = d.note ?? undefined;

    const updated = await db/*sql*/`
      UPDATE tasks SET
        title        = COALESCE(${titleVal}::text,        title),
        job_type     = COALESCE(${jobTypeVal}::text,      job_type),
        start_date   = COALESCE(${startDateVal}::date,    start_date),
        end_date     = COALESCE(${endDateVal}::date,      end_date),
        area         = COALESCE(${areaVal}::numeric,      area),
        trucks       = COALESCE(${trucksVal}::int,        trucks),
        status       = COALESCE(${statusVal}::text,       status),
        color        = COALESCE(${colorVal}::text,        color),
        tags         = COALESCE(${tagsVal}::text[],       tags),
        progress     = CASE
                         WHEN (${progressVal}::numeric(3,1)) IS NULL THEN progress
                         ELSE GREATEST(0.0::numeric(3,1),
                                       LEAST(1.0::numeric(3,1), (${progressVal})::numeric(3,1)))
                       END,
        note         = COALESCE(${noteVal}::text,         note)
      WHERE id = ${id}
      RETURNING *
    `;
    if (!updated.length) return responseError(c, "not_found", 404);

    if (Array.isArray(d.assigneeConfigs)) {
      await db`DELETE FROM task_assignees WHERE task_id = ${id}`;
      await upsertAssignees(db, id, d.assigneeConfigs);
    } else if (Array.isArray(d.assigneeIds) || Array.isArray(d.assigneeUsernames)) {
      await db`DELETE FROM task_assignees WHERE task_id = ${id}`;
      if (Array.isArray(d.assigneeIds) && d.assigneeIds.length > 0) {
        for (const uid of d.assigneeIds) {
          await db/*sql*/`
            INSERT INTO task_assignees (task_id, user_id, use_default)
            VALUES (${id}::int, ${uid}::int, true)
            ON CONFLICT DO NOTHING
          `;
        }
      } else if (Array.isArray(d.assigneeUsernames) && d.assigneeUsernames.length > 0) {
        const urows = await db<{ id: number }>`
          SELECT id FROM users WHERE username = ANY(${d.assigneeUsernames}::text[])
        `;
        for (const u2 of urows) {
          await db/*sql*/`
            INSERT INTO task_assignees (task_id, user_id, use_default)
            VALUES (${id}::int, ${u2.id}::int, true)
          `;
        }
      }
    }

    const assignees = await fetchAssigneesJson(db, id);
    return responseSuccess(c, "updated", { task: { ...updated[0], assignees } });
  } catch (e: any) {
    console.error("PATCH /tasks/:id ERROR:", e);
    return responseError(c, "internal", 500, e?.message ?? String(e));
  }
});

/** -------- PAYMENTS APIs (boss/admin) -------- */
router.post("/:id/payments", auth, requireRole(["boss", "admin"]), async (c) => {
  try {
    const db = getDb((c as any).env);
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}));
    const amount = Number(body?.amount || 0);
    const note = body?.note ?? null;

    if (!Number.isInteger(amount) || amount <= 0) {
      return responseError(c, "amount invalid", 400);
    }

    const exists = await db/*sql*/`SELECT 1 FROM tasks WHERE id = ${id} LIMIT 1`;
    if (!exists.length) return responseError(c, "not_found", 404);

    await db/*sql*/`BEGIN`;
    try {
      await db/*sql*/`
        INSERT INTO task_payments (task_id, amount, note)
        VALUES (${id}::int, ${amount}::int, ${note}::text)
      `;
      await db/*sql*/`
        UPDATE tasks SET paid_amount = paid_amount + ${amount}::int
        WHERE id = ${id}::int
      `;
      await db/*sql*/`COMMIT`;
    } catch (e) {
      await db/*sql*/`ROLLBACK`;
      return responseError(c, "payment_failed", 500, (e as any)?.message);
    }

    return responseSuccess(c, "payment recorded", { id, amount }, 201);
  } catch (e: any) {
    console.error("POST /tasks/:id/payments ERROR:", e);
    return responseError(c, "internal", 500, e?.message ?? String(e));
  }
});

router.get("/:id/payments", auth, async (c) => {
  try {
    const db = getDb((c as any).env);
    const id = Number(c.req.param("id"));

    const exists = await db/*sql*/`SELECT 1 FROM tasks WHERE id = ${id} LIMIT 1`;
    if (!exists.length) return responseError(c, "not_found", 404);

    const rows = await db/*sql*/`
      SELECT id, task_id, amount, note, created_at
      FROM task_payments
      WHERE task_id = ${id}
      ORDER BY created_at DESC, id DESC
    `;
    return responseSuccess(c, "payments", { taskId: id, count: rows.length, items: rows });
  } catch (e: any) {
    console.error("GET /tasks/:id/payments ERROR:", e);
    return responseError(c, "internal", 500, e?.message ?? String(e));
  }
});

router.delete("/:id/payments/:paymentId", auth, requireRole(["boss", "admin"]), async (c) => {
  try {
    const db = getDb((c as any).env);
    const id = Number(c.req.param("id"));
    const pid = Number(c.req.param("paymentId"));
    if (!Number.isInteger(pid) || pid <= 0) return responseError(c, "invalid payment id", 400);

    const prow = await db<{ id: number; task_id: number; amount: number }>`
      SELECT id, task_id, amount
      FROM task_payments
      WHERE id = ${pid} AND task_id = ${id}
      LIMIT 1
    `;
    if (!prow.length) return responseError(c, "not_found", 404);

    await db/*sql*/`BEGIN`;
    try {
      await db/*sql*/`DELETE FROM task_payments WHERE id = ${pid}`;
      await db/*sql*/`
        UPDATE tasks SET paid_amount = GREATEST(0, paid_amount - ${prow[0].amount}::int)
        WHERE id = ${id}
      `;
      await db/*sql*/`COMMIT`;
    } catch (e) {
      await db/*sql*/`ROLLBACK`;
      return responseError(c, "delete_payment_failed", 500, (e as any)?.message);
    }

    return responseSuccess(c, "payment_deleted", { paymentId: pid });
  } catch (e: any) {
    console.error("DELETE /tasks/:id/payments/:paymentId ERROR:", e);
    return responseError(c, "internal", 500, e?.message ?? String(e));
  }
});

/** -------- DELETE /tasks/:id (boss/admin) -------- */
router.delete("/:id", auth, requireRole(["boss", "admin"]), async (c) => {
  try {
    const db = getDb((c as any).env);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return responseError(c, "invalid id", 400);
    }

    const exists = await db/*sql*/`SELECT 1 FROM tasks WHERE id = ${id} LIMIT 1`;
    if (!exists.length) return responseError(c, "not_found", 404);

    await db/*sql*/`BEGIN`;
    try {
      await db/*sql*/`DELETE FROM task_payments WHERE task_id = ${id}`;
      await db/*sql*/`DELETE FROM task_assignees WHERE task_id = ${id}`;
      await db/*sql*/`DELETE FROM tasks WHERE id = ${id}`;
      await db/*sql*/`COMMIT`;
    } catch (e) {
      await db/*sql*/`ROLLBACK`;
      return responseError(c, "delete_failed", 500, (e as any)?.message);
    }

    return responseSuccess(c, "deleted", { id });
  } catch (e: any) {
    console.error("DELETE /tasks/:id ERROR:", e);
    return responseError(c, "internal", 500, e?.message ?? String(e));
  }
});

export default router;
