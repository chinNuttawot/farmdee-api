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
        COALESCE((
          SELECT json_agg(
                   json_build_object('id', u2.id, 'username', u2.username)
                   ORDER BY u2.username
                 )
          FROM task_assignees ta
          JOIN users u2 ON u2.id = ta.user_id
          WHERE ta.task_id = t.id
        ), '[]'::json) AS assignees
      FROM tasks t
      WHERE
        t.start_date >= COALESCE(${fromParam}, t.start_date)
        AND t.end_date   <= COALESCE(${toParam},   t.end_date)
        AND t.status     =  COALESCE(${statusParam},  t.status)
        AND t.job_type   =  COALESCE(${jobTypeParam}, t.job_type)
      ORDER BY t.start_date ASC, t.id ASC
    `;
    return c.json(rows);
  } else {
    const rows = await db/*sql*/`
      SELECT
        t.*,
        COALESCE((
          SELECT json_agg(
                   json_build_object('id', u2.id, 'username', u2.username)
                   ORDER BY u2.username
                 )
          FROM task_assignees ta
          JOIN users u2 ON u2.id = ta.user_id
          WHERE ta.task_id = t.id
        ), '[]'::json) AS assignees
      FROM tasks t
      JOIN task_assignees ta_v
        ON ta_v.task_id = t.id
       AND ta_v.user_id = ${u.id}
      WHERE
        t.start_date >= COALESCE(${fromParam}, t.start_date)
        AND t.end_date   <= COALESCE(${toParam},   t.end_date)
        AND t.status     =  COALESCE(${statusParam},  t.status)
        AND t.job_type   =  COALESCE(${jobTypeParam}, t.job_type)
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

  // 1) มี task นี้ไหม
  const exists = await db`SELECT 1 FROM tasks WHERE id = ${id} LIMIT 1`;
  if (!exists.length) return c.json({ error: "not_found" }, 404);

  // 2) มีสิทธิ์เห็นไหม
  if (!isBossOrAdmin(u)) {
    const canSee = await db`
      SELECT 1
      FROM task_assignees
      WHERE task_id = ${id} AND user_id = ${u.id}
      LIMIT 1
    `;
    if (!canSee.length) return c.json({ error: "forbidden" }, 403);
  }

  // 3) ดึงข้อมูล + assignees
  const rows = await db/*sql*/`
    SELECT
      t.*,
      COALESCE((
        SELECT json_agg(
                 json_build_object('id', u2.id, 'username', u2.username)
                 ORDER BY u2.username
               )
        FROM task_assignees ta
        JOIN users u2 ON u2.id = ta.user_id
        WHERE ta.task_id = t.id
      ), '[]'::json) AS assignees
    FROM tasks t
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
      ${d.title}, ${d.jobType}, ${d.startDate}, ${d.endDate},
      ${d.area ?? null}, ${d.trucks ?? null},
      ${d.totalAmount}, ${d.paidAmount ?? 0},
      ${d.note ?? null}, ${d.status ?? 'รอทำ'},
      ${d.color ?? null}, ${d.tags ?? []},
      0, ${creator.id}
    ) RETURNING id
  `;
  const taskId = trow[0].id;

  if (d.assigneeIds?.length) {
    for (const uid of d.assigneeIds) {
      await db`INSERT INTO task_assignees (task_id, user_id) VALUES (${taskId}, ${uid}) ON CONFLICT DO NOTHING`;
    }
  } else if (d.assigneeUsernames?.length) {
    const urows = await db<{ id: number }>`SELECT id FROM users WHERE username = ANY(${d.assigneeUsernames})`;
    for (const u2 of urows) {
      await db`INSERT INTO task_assignees (task_id, user_id) VALUES (${taskId}, ${u2.id}) ON CONFLICT DO NOTHING`;
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

  // ตรวจสิทธิ์อ่าน (ใช้ JOIN สำหรับ user ปกติ)
  if (isBossOrAdmin(u)) {
    const can = await db`SELECT 1 FROM tasks WHERE id = ${id} LIMIT 1`;
    if (!can.length) return c.json({ error: "forbidden" }, 403);
  } else {
    const can = await db/*sql*/`
      SELECT 1
      FROM tasks t
      JOIN task_assignees ta_v
        ON ta_v.task_id = t.id
       AND ta_v.user_id = ${u.id}
      WHERE t.id = ${id}
      LIMIT 1
    `;
    if (!can.length) return c.json({ error: "forbidden" }, 403);
  }

  const admin = isBossOrAdmin(u);

  const titleVal = admin ? d.title : undefined;
  const jobTypeVal = admin ? d.jobType : undefined;
  const startDateVal = admin ? d.startDate : undefined;
  const endDateVal = admin ? d.endDate : undefined;
  const areaVal = admin ? d.area : undefined;
  const trucksVal = admin ? d.trucks : undefined;
  const totalAmountVal = admin ? d.totalAmount : undefined;
  const paidAmountVal = admin ? d.paidAmount : undefined;
  const statusVal = admin ? d.status : undefined;
  const colorVal = admin ? d.color : undefined;
  const tagsVal = admin ? d.tags : undefined;

  const progressVal = d.progress !== undefined ? d.progress : undefined;
  const noteVal = d.note !== undefined ? d.note : undefined;

  const updated = await db/*sql*/`
    UPDATE tasks SET
      title        = COALESCE(${titleVal},       title),
      job_type     = COALESCE(${jobTypeVal},     job_type),
      start_date   = COALESCE(${startDateVal},   start_date),
      end_date     = COALESCE(${endDateVal},     end_date),
      area         = COALESCE(${areaVal},        area),
      trucks       = COALESCE(${trucksVal},      trucks),
      total_amount = COALESCE(${totalAmountVal}, total_amount),
      paid_amount  = COALESCE(${paidAmountVal},  paid_amount),
      status       = COALESCE(${statusVal},      status),
      color        = COALESCE(${colorVal},       color),
      tags         = COALESCE(${tagsVal},        tags),
      progress     = COALESCE(${progressVal},    progress),
      note         = COALESCE(${noteVal},        note)
    WHERE id = ${id}
    RETURNING *
  `;

  if (!updated.length) {
    // โดยปกติไม่ควรเกิด เพราะผ่านสิทธิ์แล้ว แต่อย่างไรเผื่อไว้
    return c.json({ error: "not_found" }, 404);
  }

  // ถ้า admin เปลี่ยน assignees ให้รีเฟรชความสัมพันธ์
  if (admin && (d.assigneeIds || d.assigneeUsernames)) {
    await db`DELETE FROM task_assignees WHERE task_id = ${id}`;
    if (d.assigneeIds?.length) {
      for (const uid of d.assigneeIds) {
        await db`INSERT INTO task_assignees (task_id, user_id) VALUES (${id}, ${uid}) ON CONFLICT DO NOTHING`;
      }
    } else if (d.assigneeUsernames?.length) {
      const urows = await db<{ id: number }>`
        SELECT id FROM users WHERE username = ANY(${d.assigneeUsernames})
      `;
      for (const u2 of urows) {
        await db`INSERT INTO task_assignees (task_id, user_id) VALUES (${id}, ${u2.id}) ON CONFLICT DO NOTHING`;
      }
    }
  }

  // อ่าน assignees แนบกลับไปใน response
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

  await db`
    INSERT INTO task_payments (task_id, amount, note)
    VALUES (${id}, ${amount}, ${note})
  `;
  await db`
    UPDATE tasks SET paid_amount = paid_amount + ${amount}
    WHERE id = ${id}
  `;

  return c.json({ message: "payment recorded" }, 201);
});

export default router;
