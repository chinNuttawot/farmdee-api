// routes/evals.ts
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import { auth } from "../middlewares/auth";
import { responseSuccess, responseError } from "../utils/responseHelper";

const router = new Hono();

/** ========= Helpers ========= */
async function getDefaultTemplateId(db: any): Promise<number | null> {
    const rows = await db/*sql*/`
    SELECT id
    FROM eval_templates
    WHERE is_published = TRUE
    ORDER BY version DESC, updated_at DESC
    LIMIT 1
  `;
    return rows[0]?.id ?? null;
}

/** ========= Schemas ========= */
const CreateEvalSchema = z.object({
    templateId: z.number().int().positive().optional(), // auto ได้
    employeeId: z.number().int().positive(),
    evaluatorId: z.number().int().positive(),
    workMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), // YYYY-MM
    roundNo: z.number().int().positive().optional(),       // รอบที่ (ออปชัน)
});

const SaveScoresSchema = z.object({
    items: z.array(
        z.object({
            itemId: z.number().int().positive(),
            score: z.number().int().min(0),
            note: z.string().optional(),
        })
    ),
    note: z.string().optional(),
});

const ListQuerySchema = z.object({
    employeeId: z.string().optional(),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), // YYYY-MM
    status: z.enum(["Draft", "Submitted", "Approved", "Rejected"]).optional(),
    roundNo: z.coerce.number().int().positive().optional(),        // filter รอบที่
});

const PrepareSchema = z.object({
    employeeId: z.coerce.number().int().positive(),
    templateId: z.coerce.number().int().positive().optional(), // auto ได้
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), // YYYY-MM
    roundNo: z.coerce.number().int().positive().optional(),   // ระบุรอบ (ออปชัน)
});

/** ========= POST /evals ========= (create draft; support round; idempotent) ========= */
router.post("/", auth, async (c) => {
    try {
        const body = await c.req.json();
        const p = CreateEvalSchema.parse(body);
        const db = getDb((c as any).env);

        const templateId = p.templateId ?? (await getDefaultTemplateId(db));
        if (!templateId) return responseError(c, "no published template", 400);

        const workMonthDate = `${p.workMonth}-01`;

        // หา round อัตโนมัติถ้าไม่ได้ส่งมา: MAX(round_no)+1
        let roundNo = p.roundNo ?? null;
        if (roundNo == null) {
            const r = await db/*sql*/`
        SELECT COALESCE(MAX(round_no), 0) + 1 AS next_round
        FROM evaluations
        WHERE employee_id=${p.employeeId}
          AND template_id=${templateId}
          AND work_month=${workMonthDate}
      `;
            roundNo = Number(r[0]?.next_round || 1);
        }

        // พยายามสร้าง ถ้าชน unique ให้คืนใบเดิม (idempotent)
        const ins = await db/*sql*/`
      INSERT INTO evaluations (template_id, employee_id, evaluator_id, work_month, round_no)
      VALUES (${templateId}, ${p.employeeId}, ${p.evaluatorId}, ${workMonthDate}, ${roundNo})
      ON CONFLICT (employee_id, work_month, template_id, round_no) DO NOTHING
      RETURNING id
    `;

        if (ins.length === 0) {
            const ex = await db/*sql*/`
        SELECT id
        FROM evaluations
        WHERE employee_id=${p.employeeId}
          AND template_id=${templateId}
          AND work_month=${workMonthDate}
          AND round_no=${roundNo}
        LIMIT 1
      `;
            return responseSuccess(c, "exists", { id: ex[0].id, roundNo }, 200);
        }

        return responseSuccess(c, "created", { id: ins[0].id, roundNo }, 201);
    } catch (err: any) {
        if (err?.issues) return responseError(c, err.issues, 400);
        return responseError(c, "failed", 400, err?.message ?? String(err));
    }
});

/** ========= GET /evals ========= (list with filters) ========= */
router.get("/", auth, async (c) => {
    try {
        const url = new URL(c.req.url);
        const q = ListQuerySchema.parse(Object.fromEntries(url.searchParams));
        const db = getDb((c as any).env);

        const empId = q.employeeId ? Number(q.employeeId) : null;
        const month = q.month ?? null;   // 'YYYY-MM'
        const status = q.status ?? null;
        const roundNo = q.roundNo ?? null;

        const rows = await db/*sql*/`
      SELECT e.id, e.template_id, e.employee_id, e.evaluator_id,
             to_char(e.work_month,'YYYY-MM') AS work_month,
             e.round_no,
             e.status, e.total_score, e.percentage, e.note,
             e.created_at, e.updated_at
      FROM evaluations e
      WHERE (${empId}::int  IS NULL OR e.employee_id = ${empId})
        AND (${month}::text IS NULL OR to_char(e.work_month,'YYYY-MM') = ${month})
        AND (${status}::text IS NULL OR e.status = ${status})
        AND (${roundNo}::int IS NULL OR e.round_no = ${roundNo})
      ORDER BY e.updated_at DESC
    `;
        return responseSuccess(c, "eval list", { count: rows.length, items: rows });
    } catch (err: any) {
        if (err?.issues) return responseError(c, err.issues, 400);
        return responseError(c, "failed", 400, err?.message ?? String(err));
    }
});

/** ========= GET /evals/prepare =========
 * มีใบของ employee+month(+template)+round เสมอ; ไม่มีให้สร้าง
 */
router.get("/prepare", auth, async (c) => {
    try {
        const url = new URL(c.req.url);
        const q = PrepareSchema.parse(Object.fromEntries(url.searchParams));
        const db = getDb((c as any).env);

        const workMonthDate = `${q.month}-01`;
        const templateId = q.templateId ?? (await getDefaultTemplateId(db));
        if (!templateId) return responseError(c, "no published template", 400);

        // ถ้าไม่ระบุรอบ → ใช้รอบล่าสุด ถ้ายังไม่มีเลยให้เป็น 1
        let roundNo = q.roundNo ?? null;
        if (roundNo == null) {
            const r = await db/*sql*/`
        SELECT COALESCE(MAX(round_no), 0) AS max_round
        FROM evaluations
        WHERE employee_id=${q.employeeId}
          AND template_id=${templateId}
          AND work_month=${workMonthDate}
      `;
            const maxRound = Number(r[0]?.max_round || 0);
            roundNo = maxRound === 0 ? 1 : maxRound; // ถ้ามีอยู่แล้ว → ใช้รอบล่าสุด
        }

        const found = await db/*sql*/`
      SELECT id FROM evaluations
      WHERE employee_id = ${q.employeeId}
        AND template_id = ${templateId}
        AND work_month  = ${workMonthDate}
        AND round_no    = ${roundNo}
      LIMIT 1
    `;
        let evalId = found[0]?.id as number | undefined;

        if (!evalId) {
            const created = await db/*sql*/`
        INSERT INTO evaluations(template_id, employee_id, evaluator_id, work_month, round_no)
        VALUES (${templateId}, ${q.employeeId}, ${0}, ${workMonthDate}, ${roundNo})
        RETURNING id
      `;
            evalId = created[0].id as number;
        }

        // reuse GET /:id
        const req = new Request(c.req.url.replace(/prepare.*/, String(evalId)), { headers: c.req.headers });
        // @ts-ignore
        return await router.routes.get("/:id")!.handler({ ...c, req } as any);
    } catch (err: any) {
        if (err?.issues) return responseError(c, err.issues, 400);
        return responseError(c, "failed", 400, err?.message ?? String(err));
    }
});

/** ========= GET /evals/:id ========= */
router.get("/:id", auth, async (c) => {
    try {
        const id = Number(c.req.param("id"));
        const db = getDb((c as any).env);

        const head = await db/*sql*/`
      SELECT e.id, e.template_id, e.employee_id, e.evaluator_id,
             to_char(e.work_month,'YYYY-MM') AS work_month,
             e.round_no,
             e.status, e.total_score, e.percentage, e.note,
             t.name AS template_name, t.total_max_score
      FROM evaluations e
      JOIN eval_templates t ON t.id = e.template_id
      WHERE e.id = ${id}
    `;
        if (head.length === 0) return responseError(c, "not found", 404);

        const rows = await db/*sql*/`
      SELECT
        sec.id             AS section_id,
        sec.title          AS section_title,
        sec.display_order  AS section_order,
        i.id               AS item_id,
        i.title            AS item_title,
        i.max_score        AS item_max,
        i.display_order    AS item_order,
        COALESCE(s.score, 0) AS score,
        s.note             AS score_note
      FROM evaluations e
      JOIN eval_sections sec ON sec.template_id = e.template_id
      JOIN eval_items    i   ON i.section_id   = sec.id
      LEFT JOIN evaluation_item_scores s
             ON s.item_id = i.id AND s.evaluation_id = e.id
      WHERE e.id = ${id}
      ORDER BY sec.display_order, i.display_order
    `;

        const sectionsMap = new Map<number, any>();
        for (const r of rows as any[]) {
            if (!sectionsMap.has(r.section_id)) {
                sectionsMap.set(r.section_id, {
                    section_id: r.section_id,
                    title: r.section_title,
                    display_order: r.section_order,
                    items: [] as any[],
                });
            }
            sectionsMap.get(r.section_id).items.push({
                item_id: r.item_id,
                title: r.item_title,
                max_score: Number(r.item_max),
                score: Number(r.score),
                note: r.score_note ?? null,
                display_order: r.item_order,
            });
        }

        return responseSuccess(c, "evaluation", {
            ...head[0],
            sections: Array.from(sectionsMap.values()),
        });
    } catch (err: any) {
        return responseError(c, "failed", 400, err?.message ?? String(err));
    }
});

/** ========= PUT /evals/:id/scores ========= */
router.put("/:id/scores", auth, async (c) => {
    try {
        const id = Number(c.req.param("id"));
        const body = await c.req.json();
        const p = SaveScoresSchema.parse(body);
        const db = getDb((c as any).env);

        const itemRows = await db/*sql*/`
      SELECT i.id AS item_id, i.max_score
      FROM evaluations e
      JOIN eval_sections sec ON sec.template_id = e.template_id
      JOIN eval_items i ON i.section_id = sec.id
      WHERE e.id = ${id}
    `;
        if (itemRows.length === 0) return responseError(c, "evaluation not found", 404);

        const itemMax = new Map<number, number>();
        for (const r of itemRows as any[]) itemMax.set(Number(r.item_id), Number(r.max_score));

        for (const it of p.items) {
            const max = itemMax.get(it.itemId);
            if (max == null) return responseError(c, `item ${it.itemId} not in template of evaluation`, 400);
            if (it.score > max) return responseError(c, `score ${it.score} > max ${max} for item ${it.itemId}`, 400);
        }

        const itemsJson = JSON.stringify(p.items.map(x => ({ itemId: x.itemId, score: x.score, note: x.note ?? null })));

        await db/*sql*/`
      WITH incoming AS (
        SELECT (j->>'itemId')::int AS item_id,
               (j->>'score')::int  AS score,
               NULLIF(j->>'note','')::text AS note
        FROM jsonb_array_elements(${itemsJson}::jsonb) j
      )
      INSERT INTO evaluation_item_scores (evaluation_id, item_id, score, note)
      SELECT ${id}, i.item_id, i.score, i.note
      FROM incoming i
      ON CONFLICT (evaluation_id, item_id)
      DO UPDATE SET score = EXCLUDED.score, note = EXCLUDED.note
    `;

        if (typeof p.note === "string") {
            await db/*sql*/`
        UPDATE evaluations SET note = ${p.note}, updated_at = NOW()
        WHERE id = ${id}
      `;
        }

        return responseSuccess(c, "scores saved");
    } catch (err: any) {
        if (err?.issues) return responseError(c, err.issues, 400);
        return responseError(c, "failed", 400, err?.message ?? String(err));
    }
});

/** ========= POST /evals/:id/submit ========= */
router.post("/:id/submit", auth, async (c) => {
    try {
        const id = Number(c.req.param("id"));
        const db = getDb((c as any).env);

        const rows = await db/*sql*/`
      WITH calc AS (
        SELECT
          e.id,
          COALESCE(SUM(s.score),0) AS total,
          t.total_max_score       AS max
        FROM evaluations e
        JOIN eval_templates t ON t.id = e.template_id
        LEFT JOIN evaluation_item_scores s ON s.evaluation_id = e.id
        WHERE e.id = ${id}
        GROUP BY e.id, t.total_max_score
      )
      UPDATE evaluations e
      SET total_score = c.total,
          percentage = CASE WHEN c.max > 0 THEN (c.total * 100.0) / c.max ELSE 0 END,
          status     = 'Submitted',
          updated_at = NOW()
      FROM calc c
      WHERE e.id = c.id
      RETURNING e.total_score AS total, e.percentage AS percent
    `;
        if (rows.length === 0) return responseError(c, "not found", 404);
        return responseSuccess(c, "submitted", rows[0]);
    } catch (err: any) {
        return responseError(c, "failed", 400, err?.message ?? String(err));
    }
});

export default router;
