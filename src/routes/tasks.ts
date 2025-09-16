// src/routes/tasks.ts
import { Hono } from "hono";
import { getDb } from "../db";
import { auth } from "../middlewares/auth";
import { requireRole, isBossOrAdmin } from "../middlewares/role";
import { CreateTaskSchema, UpdateTaskSchema } from "../schemas/task";

const router = new Hono();

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
    const ratePerRai = useDefault ? null : (cfg.ratePerRai ?? null);
    const repairRate = useDefault ? null : (cfg.repairRate ?? null);
    const dailyRate = useDefault ? null : (cfg.dailyRate ?? null);

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

const assigneesJsonAgg = /*sql*/`
  SELECT json_agg(
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
`;

/** -------- GET /tasks --------
 * boss/admin: เห็นทั้งหมด
 * user: เห็นเฉพาะงานที่ตัวเองถูก assign
 * รองรับ query: ?from=YYYY-MM-DD&to=YYYY-MM-DD&status=...&jobType=...
 */
router.get("/", auth, async (c) => {
  const db = getDb((c as any).env);
  const u = c.get("user") as { id: number; role?: string };

  const q = c.req.query();
  const fromParam = q.from ?? null;
  const toParam = q.to ?? null;
  const statusParam = q.status ?? null;
  const jobTypeParam = q.jobType ?? null;

  if (isBossOrAdmin(u)) {
    const rows = await db/*sql*/`
      SELECT
        t.*,
        COALESCE(a.assignees, '[]'::json) AS assignees
      FROM tasks t
      LEFT JOIN LATERAL (
        ${assigneesJsonAgg}
      ) a ON TRUE
      WHERE
        (${fromParam}::date IS NULL OR t.start_date >= ${fromParam}::date)
        AND (${toParam}::date   IS NULL OR t.end_date   <= ${toParam}::date)
        AND (${statusParam}::text   IS NULL OR t.status   = ${statusParam}::text)
        AND (${jobTypeParam}::text  IS NULL OR t.job_type = ${jobTypeParam}::text)
      ORDER BY t.start_date ASC, t.id ASC
    `;
    return c.json(rows);
  } else {
    const rows = await db/*sql*/`
      SELECT
        t.*,
        COALESCE(a.assignees, '[]'::json) AS assignees
      FROM tasks t
      JOIN task_assignees ta_v
        ON ta_v.task_id = t.id
       AND ta_v.user_id = ${u.id}
      LEFT JOIN LATERAL (
        ${assigneesJsonAgg}
      ) a ON TRUE
      WHERE
        (${fromParam}::date IS NULL OR t.start_date >= ${fromParam}::date)
        AND (${toParam}::date   IS NULL OR t.end_date   <= ${toParam}::date)
        AND (${statusParam}::text   IS NULL OR t.status   = ${statusParam}::text)
        AND (${jobTypeParam}::text  IS NULL OR t.job_type = ${jobTypeParam}::text)
      ORDER BY t.start_date ASC, t.id ASC
    `;
    return c.json(rows);
  }
});

/** -------- GET /tasks/:id -------- */
router.get("/:id", auth, async (c) => {
  const db = getDb((c as any).env);
  const u = c.get("user") as { id: number; role?: string };
  const id = Number(c.req.param("id"));

  const exists = await db`SELECT 1 FROM tasks WHERE id = ${id} LIMIT 1`;
  if (!exists.length) return c.json({ error: "not_found" }, 404);

  if (!isBossOrAdmin(u)) {
    const canSee = await db/*sql*/`
      SELECT 1
      FROM task_assignees
      WHERE task_id = ${id} AND user_id = ${u.id}
      LIMIT 1
    `;
    if (!canSee.length) return c.json({ error: "forbidden" }, 403);
  }

  const rows = await db/*sql*/`
    SELECT
      t.*,
      COALESCE(a.assignees, '[]'::json) AS assignees
    FROM tasks t
    LEFT JOIN LATERAL (
      ${assigneesJsonAgg}
    ) a ON TRUE
    WHERE t.id = ${id}
    LIMIT 1
  `;
  return c.json(rows[0]);
});

/** -------- POST /tasks (boss/admin) --------
 * รองรับ assigneeConfigs: [{ userId|username, useDefault, ratePerRai, repairRate, dailyRate }]
 */
router.post("/", auth, requireRole(["boss", "admin"]), async (c) => {
  const db = getDb((c as any).env);
  const creator = c.get("user") as { id: number };

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const parsed = CreateTaskSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d: any = parsed.data;

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
      ${d.totalAmount ?? 0}::int,   -- บันทึกเงินเฉพาะตอนสร้าง
      ${d.paidAmount ?? 0}::int,  -- บันทึกเงินเฉพาะตอนสร้าง
      ${d.note ?? null}::text,
      ${d.status ?? 'รอทำ'}::text,
      ${d.color ?? null}::text,
      ${d.tags ?? []}::text[],
      ${0.0}::numeric(3,1),
      ${creator.id}::int
    )
    RETURNING id
  `;
  const taskId = trow[0].id;

  // 1) โหมดใหม่: assigneeConfigs
  if (Array.isArray(d.assigneeConfigs) && d.assigneeConfigs.length > 0) {
    await upsertAssignees(db, taskId, d.assigneeConfigs);
  } else {
    // 2) โหมดเดิม: ids หรือ usernames (จะถือว่าใช้ default ทั้งหมด)
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

  return c.json({ message: "created", id: taskId }, 201);
});

/** -------- PATCH /tasks/:id --------
 * user: แก้ได้เฉพาะ progress, note
 * boss/admin: แก้ได้หลายฟิลด์ แต่ "ไม่ให้แก้เงิน" (total_amount/paid_amount)
 */
router.patch("/:id", auth, async (c) => {
  const db = getDb((c as any).env);
  const u = c.get("user") as { id: number; role?: string };
  const id = Number(c.req.param("id"));

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const parsed = UpdateTaskSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d: any = parsed.data;

  // permission to see/update
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
  if (!can.length) return c.json({ error: "forbidden" }, 403);

  const admin = isBossOrAdmin(u);

  if (!admin) {
    // ----- USER: progress/note เท่านั้น -----
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
    if (!updated.length) return c.json({ error: "not_found" }, 404);

    const assignees = await db/*sql*/`
      ${assigneesJsonAgg.replaceAll("t.id", `${id}`)}
    `;
    return c.json({
      message: "updated",
      task: { ...updated[0], assignees: (assignees as any)[0]?.assignees ?? [] },
    });
  }

  // ----- ADMIN: ห้ามอัปเดตเงิน -----
  const titleVal = d.title ?? null;
  const jobTypeVal = d.jobType ?? null;
  const startDateVal = d.startDate ?? null;
  const endDateVal = d.endDate ?? null;
  const areaVal = d.area ?? null;
  const trucksVal = d.trucks ?? null;
  const statusVal = d.status ?? null;
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
  if (!updated.length) return c.json({ error: "not_found" }, 404);

  // อัปเดตผู้รับงานถ้าส่ง assigneeConfigs มา
  if (Array.isArray(d.assigneeConfigs)) {
    // เลือกวิธีรีเฟรชทั้งชุดเพื่อให้ตรงกับ UI
    await db`DELETE FROM task_assignees WHERE task_id = ${id}`;
    await upsertAssignees(db, id, d.assigneeConfigs);
  } else if (Array.isArray(d.assigneeIds) || Array.isArray(d.assigneeUsernames)) {
    // โหมดเดิม: ถือว่าใช้ default ทั้งหมด
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

  const assignees = await db/*sql*/`
    ${assigneesJsonAgg.replaceAll("t.id", `${id}`)}
  `;
  return c.json({
    message: "updated",
    task: { ...updated[0], assignees: (assignees as any)[0]?.assignees ?? [] },
  });
});

/** -------- PAYMENTS APIs (boss/admin) -------- */

/** POST /tasks/:id/payments  -> เพิ่มการจ่ายเงินของงาน */
router.post("/:id/payments", auth, requireRole(["boss", "admin"]), async (c) => {
  const db = getDb((c as any).env);
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const amount = Number(body?.amount || 0);
  const note = body?.note ?? null;

  if (!Number.isInteger(amount) || amount <= 0) {
    return c.json({ error: "amount invalid" }, 400);
  }

  // งานต้องมีอยู่
  const exists = await db/*sql*/`SELECT 1 FROM tasks WHERE id = ${id} LIMIT 1`;
  if (!exists.length) return c.json({ error: "not_found" }, 404);

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
    return c.json({ error: "payment_failed", detail: (e as any)?.message }, 500);
  }

  return c.json({ message: "payment recorded" }, 201);
});

/** GET /tasks/:id/payments  -> ดูรายการจ่ายเงินของงาน */
router.get("/:id/payments", auth, async (c) => {
  const db = getDb((c as any).env);
  const id = Number(c.req.param("id"));

  const exists = await db/*sql*/`SELECT 1 FROM tasks WHERE id = ${id} LIMIT 1`;
  if (!exists.length) return c.json({ error: "not_found" }, 404);

  const rows = await db/*sql*/`
    SELECT id, task_id, amount, note, created_at
    FROM task_payments
    WHERE task_id = ${id}
    ORDER BY created_at DESC, id DESC
  `;
  return c.json(rows);
});

/** DELETE /tasks/:id/payments/:paymentId  -> ลบรายการจ่ายเงิน 1 รายการของงาน */
router.delete("/:id/payments/:paymentId", auth, requireRole(["boss", "admin"]), async (c) => {
  const db = getDb((c as any).env);
  const id = Number(c.req.param("id"));
  const pid = Number(c.req.param("paymentId"));
  if (!Number.isInteger(pid) || pid <= 0) return c.json({ error: "invalid payment id" }, 400);

  // หา payment + งานก่อน
  const prow = await db<{ id: number; task_id: number; amount: number }>`
    SELECT id, task_id, amount
    FROM task_payments
    WHERE id = ${pid} AND task_id = ${id}
    LIMIT 1
  `;
  if (!prow.length) return c.json({ error: "not_found" }, 404);

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
    return c.json({ error: "delete_payment_failed", detail: (e as any)?.message }, 500);
  }

  return c.json({ message: "payment_deleted", paymentId: pid });
});

/** -------- DELETE /tasks/:id (boss/admin) --------
 * ลบเฉพาะข้อมูลที่เกี่ยวข้องกับงานนี้: payments, assignees แล้วค่อยลบ task
 */
router.delete("/:id", auth, requireRole(["boss", "admin"]), async (c) => {
  const db = getDb((c as any).env);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "invalid id" }, 400);
  }

  // มีงานนี้จริงไหม
  const exists = await db/*sql*/`SELECT 1 FROM tasks WHERE id = ${id} LIMIT 1`;
  if (!exists.length) return c.json({ error: "not_found" }, 404);

  await db/*sql*/`BEGIN`;
  try {
    // 1) ลบข้อมูลจ่ายเงินของงานนี้
    await db/*sql*/`DELETE FROM task_payments WHERE task_id = ${id}`;

    // 2) ลบผู้รับงานของงานนี้
    await db/*sql*/`DELETE FROM task_assignees WHERE task_id = ${id}`;

    // 3) ลบตัวงาน
    await db/*sql*/`DELETE FROM tasks WHERE id = ${id}`;

    await db/*sql*/`COMMIT`;
  } catch (e) {
    await db/*sql*/`ROLLBACK`;
    return c.json({ error: "delete_failed", detail: (e as any)?.message }, 500);
  }

  return c.json({ message: "deleted", id });
});

export default router;
