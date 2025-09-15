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

    const { from, to, status, jobType } = c.req.query();
    const where = [];
    if (from) where.push(db`t.start_date >= ${from}`);
    if (to) where.push(db`t.end_date   <= ${to}`);
    if (status) where.push(db`t.status     = ${status}`);
    if (jobType) where.push(db`t.job_type   = ${jobType}`);

    const visible = isBossOrAdmin(u)
        ? db`TRUE`
        : db`EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${u.id})`;

    const rows = await db`
    SELECT t.*,
           COALESCE(json_agg(json_build_object('id',u2.id,'username',u2.username) ORDER BY u2.username)
                    FILTER (WHERE u2.id IS NOT NULL), '[]') AS assignees
    FROM tasks t
    LEFT JOIN task_assignees ta ON ta.task_id = t.id
    LEFT JOIN users u2 ON u2.id = ta.user_id
    WHERE ${visible}
      ${where.length ? db`AND ${db.raw(where.map(String).join(" AND "))}` : db``}
    GROUP BY t.id
    ORDER BY t.start_date ASC, t.id ASC
  `;
    return c.json(rows);
});

/** GET /tasks/:id — บังคับสิทธิ์อ่านตามเดียวกับด้านบน */
router.get("/:id", auth, async (c) => {
    const db = getDb((c as any).env);
    const u = c.get("user") as { id: number; role?: string };
    const id = Number(c.req.param("id"));

    const visible = isBossOrAdmin(u)
        ? db`TRUE`
        : db`EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${u.id})`;

    const rows = await db`
    SELECT t.*,
           COALESCE(json_agg(json_build_object('id',u2.id,'username',u2.username) ORDER BY u2.username)
                    FILTER (WHERE u2.id IS NOT NULL), '[]') AS assignees
    FROM tasks t
    LEFT JOIN task_assignees ta ON ta.task_id = t.id
    LEFT JOIN users u2 ON u2.id = ta.user_id
    WHERE t.id = ${id} AND ${visible}
    GROUP BY t.id
  `;
    if (!rows.length) return c.json({ error: "not_found" }, 404);
    return c.json(rows[0]);
});

/** POST /tasks — ให้เฉพาะ boss/admin สร้างงาน */
router.post("/", auth, requireRole(['boss', 'admin']), async (c) => {
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
      ${d.title}, ${d.jobType}, ${d.startDate}, ${d.endDate}, ${d.area ?? null},
      ${d.trucks ?? null}, ${d.totalAmount}, ${d.paidAmount ?? 0}, ${d.note ?? null},
      ${d.status ?? 'รอทำ'}, ${d.color ?? null}, ${d.tags ?? []}, 0, ${creator.id}
    ) RETURNING id
  `;
    const taskId = trow[0].id;

    // ผูก assignees
    if (d.assigneeIds?.length) {
        for (const uid of d.assigneeIds) {
            await db`INSERT INTO task_assignees (task_id, user_id)
               VALUES (${taskId}, ${uid}) ON CONFLICT DO NOTHING`;
        }
    } else if (d.assigneeUsernames?.length) {
        const urows = await db<{ id: number }>`
      SELECT id FROM users WHERE username = ANY(${d.assigneeUsernames})
    `;
        for (const u2 of urows) {
            await db`INSERT INTO task_assignees (task_id, user_id)
               VALUES (${taskId}, ${u2.id}) ON CONFLICT DO NOTHING`;
        }
    }

    return c.json({ message: "created", id: taskId }, 201);
});

/** PATCH /tasks/:id
 * boss/admin: แก้ได้ทุกฟิลด์
 * user: จำกัดให้แก้เฉพาะ progress, note (และถ้าจะให้แก้ paid ต้องออก endpoint แยก)
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

    // ตรวจสิทธิ์เข้าถึงงานนี้
    const visible = isBossOrAdmin(u)
        ? db`TRUE`
        : db`EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = ${id} AND ta.user_id = ${u.id})`;

    const canRead = await db`SELECT 1 FROM tasks t WHERE t.id = ${id} AND ${visible}`;
    if (!canRead.length) return c.json({ error: "forbidden" }, 403);

    // Build SET ตามสิทธิ์
    const sets: any[] = [];
    const push = (frag: any) => sets.push(frag);

    if (isBossOrAdmin(u)) {
        if (d.title !== undefined) push(db`title = ${d.title}`);
        if (d.jobType !== undefined) push(db`job_type = ${d.jobType}`);
        if (d.startDate !== undefined) push(db`start_date = ${d.startDate}`);
        if (d.endDate !== undefined) push(db`end_date = ${d.endDate}`);
        if (d.area !== undefined) push(db`area = ${d.area}`);
        if (d.trucks !== undefined) push(db`trucks = ${d.trucks}`);
        if (d.totalAmount !== undefined) push(db`total_amount = ${d.totalAmount}`);
        if (d.paidAmount !== undefined) push(db`paid_amount = ${d.paidAmount}`);
        if (d.status !== undefined) push(db`status = ${d.status}`);
        if (d.color !== undefined) push(db`color = ${d.color}`);
        if (d.tags !== undefined) push(db`tags = ${d.tags}`);

        if (d.assigneeIds || d.assigneeUsernames) {
            await db`DELETE FROM task_assignees WHERE task_id = ${id}`;
            if (d.assigneeIds?.length) {
                for (const uid of d.assigneeIds) {
                    await db`INSERT INTO task_assignees (task_id, user_id) VALUES (${id}, ${uid}) ON CONFLICT DO NOTHING`;
                }
            } else if (d.assigneeUsernames?.length) {
                const urows = await db<{ id: number }>`SELECT id FROM users WHERE username = ANY(${d.assigneeUsernames})`;
                for (const u2 of urows) {
                    await db`INSERT INTO task_assignees (task_id, user_id) VALUES (${id}, ${u2.id}) ON CONFLICT DO NOTHING`;
                }
            }
        }
    }

    // ฟิลด์ที่ user แก้ได้
    if (d.progress !== undefined) push(db`progress = ${d.progress}`);
    if (d.note !== undefined) push(db`note = ${d.note}`);

    if (sets.length) {
        await db`UPDATE tasks SET ${db.raw(sets.map(String).join(", "))} WHERE id = ${id}`;
    }

    return c.json({ message: "updated" });
});

/** POST /tasks/:id/payments — ให้ boss/admin เท่านั้น */
router.post("/:id/payments", auth, requireRole(['boss', 'admin']), async (c) => {
    const db = getDb((c as any).env);
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}));
    const amount = Number(body?.amount || 0);
    const note = body?.note ?? null;
    if (!Number.isInteger(amount) || amount <= 0) return c.json({ error: "amount invalid" }, 400);

    await db`INSERT INTO task_payments (task_id, amount, note) VALUES (${id}, ${amount}, ${note})`;
    await db`UPDATE tasks SET paid_amount = paid_amount + ${amount} WHERE id = ${id}`;
    return c.json({ message: "payment recorded" }, 201);
});

export default router;
