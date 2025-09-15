// src/routes/tasks.ts
import { Hono } from "hono";
import { getDb } from "../db";
import { auth } from "../middlewares/auth";
import { requireRole, isBossOrAdmin } from "../middlewares/role";
import { CreateTaskSchema, UpdateTaskSchema } from "../schemas/task";

const router = new Hono();

/** GET /tasks
 * boss/admin: เห็นทั้งหมด
 * user: เห็นเฉพาะงานที่ตัวเองถูก assign
 * รองรับ query: ?from=YYYY-MM-DD&to=YYYY-MM-DD&status=...&jobType=...
 */
router.get("/", auth, async (c) => {
  const db = getDb((c as any).env);
  const u = c.get("user") as { id: number; role?: string };

  const q = c.req.query();
  const fromParam = q.from ?? null;       // YYYY-MM-DD
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
        SELECT json_agg(
                 json_build_object('id', u2.id, 'username', u2.username)
                 ORDER BY u2.username
               ) AS assignees
        FROM task_assignees ta
        JOIN users u2 ON u2.id = ta.user_id
        WHERE ta.task_id = t.id
      ) a ON TRUE
      WHERE
        (${fromParam}::date IS NULL OR t.start_date >= ${fromParam}::date)
        AND (${toParam}::date IS NULL OR t.end_date   <= ${toParam}::date)
        AND (${statusParam}::text IS NULL OR t.status   = ${statusParam}::text)
        AND (${jobTypeParam}::text IS NULL OR t.job_type = ${jobTypeParam}::text)
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
        SELECT json_agg(
                 json_build_object('id', u2.id, 'username', u2.username)
                 ORDER BY u2.username
               ) AS assignees
        FROM task_assignees ta
        JOIN users u2 ON u2.id = ta.user_id
        WHERE ta.task_id = t.id
      ) a ON TRUE
      WHERE
        (${fromParam}::date IS NULL OR t.start_date >= ${fromParam}::date)
        AND (${toParam}::date IS NULL OR t.end_date   <= ${toParam}::date)
        AND (${statusParam}::text IS NULL OR t.status   = ${statusParam}::text)
        AND (${jobTypeParam}::text IS NULL OR t.job_type = ${jobTypeParam}::text)
      ORDER BY t.start_date ASC, t.id ASC
    `;
    return c.json(rows);
  }
});

/** GET /tasks/:id — สิทธิ์อ่านเหมือน /tasks */
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
      SELECT json_agg(
               json_build_object('id', u2.id, 'username', u2.username)
               ORDER BY u2.username
             ) AS assignees
      FROM task_assignees ta
      JOIN users u2 ON u2.id = ta.user_id
      WHERE ta.task_id = t.id
    ) a ON TRUE
    WHERE t.id = ${id}
    LIMIT 1
  `;
  return c.json(rows[0]);
});

/** POST /tasks — boss/admin เท่านั้น */
router.post("/", auth, requireRole(["boss", "admin"]), async (c) => {
  const db = getDb((c as any).env);
  const creator = c.get("user") as { id: number };

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const parsed = CreateTaskSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data;

  const trow = await db<{ id: number }>`
    INSERT INTO tasks (
      title, job_type, start_date, end_date, area, trucks,
      total_amount, paid_amount, note, status, color, tags, progress, created_by
    ) VALUES (
      ${d.title}::text,
      ${d.jobType}::text,
      ${d.startDate}::date,
      ${d.endDate}::date,
      ${d.area ?? null}::text,
      ${d.trucks ?? null}::int,
      ${d.totalAmount}::int,
      ${d.paidAmount ?? 0}::int,
      ${d.note ?? null}::text,
      ${d.status ?? 'รอทำ'}::text,
      ${d.color ?? null}::text,
      ${d.tags ?? []}::jsonb,
      ${0.0}::numeric(3,1),
      ${creator.id}::int
    )
    RETURNING id
  `;
  const taskId = trow[0].id;

  if (Array.isArray(d.assigneeIds) && d.assigneeIds.length > 0) {
    for (const uid of d.assigneeIds) {
      await db/*sql*/`
        INSERT INTO task_assignees (task_id, user_id)
        VALUES (${taskId}::int, ${uid}::int)
        ON CONFLICT DO NOTHING
      `;
    }
  } else if (Array.isArray(d.assigneeUsernames) && d.assigneeUsernames.length > 0) {
    const urows = await db<{ id: number }>`
      SELECT id FROM users WHERE username = ANY(${d.assigneeUsernames}::text[])
    `;
    for (const u2 of urows) {
      await db/*sql*/`
        INSERT INTO task_assignees (task_id, user_id)
        VALUES (${taskId}::int, ${u2.id}::int)
        ON CONFLICT DO NOTHING
      `;
    }
  }

  return c.json({ message: "created", id: taskId }, 201);
});

/** PATCH /tasks/:id
 * boss/admin: แก้ได้ทุกฟิลด์
 * user: ปรับได้เฉพาะ progress, note
 */
router.patch("/:id", auth, async (c) => {
  const db = getDb((c as any).env);
  const u = c.get("user") as { id: number; role?: string };
  const id = Number(c.req.param("id"));

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const parsed = UpdateTaskSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data;

  // check permission to see the task
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

  // -------- USER (non-admin): update เฉพาะ progress, note --------
  if (!admin) {
    const progressVal = d.progress ?? null; // 0..1 หรือ null = ไม่อัปเดต
    const noteVal = d.note ?? undefined;

    const updated = await db/*sql*/`
      UPDATE tasks SET
        progress = CASE
          WHEN (${progressVal}::numeric(3,1)) IS NULL THEN progress
          ELSE GREATEST(
                 0.0::numeric(3,1),
                 LEAST(1.0::numeric(3,1), (${progressVal})::numeric(3,1))
               )
        END,
        note = COALESCE(${noteVal}::text, note)
      WHERE id = ${id}
      RETURNING *
    `;

    if (!updated.length) return c.json({ error: "not_found" }, 404);

    const assignees = await db/*sql*/`
      SELECT json_agg(json_build_object('id', u2.id, 'username', u2.username) ORDER BY u2.username) AS assignees
      FROM task_assignees ta
      JOIN users u2 ON u2.id = ta.user_id
      WHERE ta.task_id = ${id}
    `;
    const task = { ...updated[0], assignees: assignees[0]?.assignees ?? [] };
    return c.json({ message: "updated", task });
  }

  // -------- ADMIN: update ได้ทุกฟิลด์ --------
  const titleVal = d.title ?? null;
  const jobTypeVal = d.jobType ?? null;
  const startDateVal = d.startDate ?? null;
  const endDateVal = d.endDate ?? null;
  const areaVal = d.area ?? null;
  const trucksVal = d.trucks ?? null;
  const totalAmountVal = d.totalAmount ?? null;
  const paidAmountVal = d.paidAmount ?? null;
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
      area         = COALESCE(${areaVal}::text,         area),
      trucks       = COALESCE(${trucksVal}::int,        trucks),
      total_amount = COALESCE(${totalAmountVal}::int,   total_amount),
      paid_amount  = COALESCE(${paidAmountVal}::int,    paid_amount),
      status       = COALESCE(${statusVal}::text,       status),
      color        = COALESCE(${colorVal}::text,        color),
      tags         = COALESCE(${tagsVal}::jsonb,        tags),
      progress     = CASE
                       WHEN (${progressVal}::numeric(3,1)) IS NULL THEN progress
                       ELSE GREATEST(
                              0.0::numeric(3,1),
                              LEAST(1.0::numeric(3,1), (${progressVal})::numeric(3,1))
                            )
                     END,
      note         = COALESCE(${noteVal}::text,         note)
    WHERE id = ${id}
    RETURNING *
  `;

  if (!updated.length) return c.json({ error: "not_found" }, 404);

  // refresh assignees if admin changed them
  if (Array.isArray(d.assigneeIds) || Array.isArray(d.assigneeUsernames)) {
    await db`DELETE FROM task_assignees WHERE task_id = ${id}`;
    if (Array.isArray(d.assigneeIds) && d.assigneeIds.length > 0) {
      for (const uid of d.assigneeIds) {
        await db/*sql*/`
          INSERT INTO task_assignees (task_id, user_id)
          VALUES (${id}::int, ${uid}::int)
          ON CONFLICT DO NOTHING
        `;
      }
    } else if (Array.isArray(d.assigneeUsernames) && d.assigneeUsernames.length > 0) {
      const urows = await db<{ id: number }>`
        SELECT id FROM users WHERE username = ANY(${d.assigneeUsernames}::text[])
      `;
      for (const u2 of urows) {
        await db/*sql*/`
          INSERT INTO task_assignees (task_id, user_id)
          VALUES (${id}::int, ${u2.id}::int)
          ON CONFLICT DO NOTHING
        `;
      }
    }
  }

  const assignees = await db/*sql*/`
    SELECT json_agg(json_build_object('id', u2.id, 'username', u2.username) ORDER BY u2.username) AS assignees
    FROM task_assignees ta
    JOIN users u2 ON u2.id = ta.user_id
    WHERE ta.task_id = ${id}
  `;
  const task = { ...updated[0], assignees: assignees[0]?.assignees ?? [] };
  return c.json({ message: "updated", task });
});

/** POST /tasks/:id/payments — boss/admin เท่านั้น */
router.post("/:id/payments", auth, requireRole(["boss", "admin"]), async (c) => {
  const db = getDb((c as any).env);
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const amount = Number(body?.amount || 0);
  const note = body?.note ?? null;

  if (!Number.isInteger(amount) || amount <= 0) {
    return c.json({ error: "amount invalid" }, 400);
  }

  await db/*sql*/`
    INSERT INTO task_payments (task_id, amount, note)
    VALUES (${id}::int, ${amount}::int, ${note}::text)
  `;
  await db/*sql*/`
    UPDATE tasks SET paid_amount = paid_amount + ${amount}::int
    WHERE id = ${id}::int
  `;

  return c.json({ message: "payment recorded" }, 201);
});

export default router;
