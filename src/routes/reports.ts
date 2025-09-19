// src/routes/reports.ts
import { Hono } from "hono";
import { getDb } from "../db";
import { auth } from "../middlewares/auth";
import { responseSuccess, responseError } from "../utils/responseHelper";

const router = new Hono();

// -------- helpers --------
function thaiToCE(thaiYear: number) {
    return thaiYear - 543;
}
const TH_MONTH_ABBR = [
    "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
    "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];
function formatThaiMonthLabel(ym: string) {
    const [y, m] = ym.split("-").map((s) => parseInt(s, 10));
    return `${TH_MONTH_ABBR[m - 1]} ${y + 543}`;
}
function rangeToMonths(range: string): number {
    if (range === "3m") return 3;
    if (range === "6m") return 6;
    return 12;
}

/** =========================
 * GET /reports/summary?range=3m|6m|12m
 * รวมยอดรายเดือนจาก public.tasks/public.expenses
 * ========================= */
router.get("/summary", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const range = c.req.query("range") ?? "3m";
        const months = rangeToMonths(range);

        // ✅ ใช้ CTE params เพื่อลดจำนวน ${}
        const rows = (await db/*sql*/`
      WITH params AS (
        SELECT ${months}::int AS months
      ),
      anchor AS (
        SELECT date_trunc('month', CURRENT_DATE)::date AS current_month
      ),
      month_span AS (
        SELECT gs::date AS month_start
        FROM anchor a
        CROSS JOIN params p
        CROSS JOIN generate_series(
          a.current_month - make_interval(months => p.months - 1),
          a.current_month,
          interval '1 month'
        ) AS gs
      ),
      inc AS (
        SELECT date_trunc('month', t.start_date)::date AS m,
               COALESCE(SUM(t.total_amount), 0)::numeric AS income
        FROM public.tasks t
        WHERE t.start_date >= (
          SELECT a.current_month - make_interval(months => p.months - 1)
          FROM anchor a CROSS JOIN params p
        )
        GROUP BY 1
      ),
      exp AS (
        SELECT date_trunc('month', e.work_date)::date AS m,
               COALESCE(SUM(e.amount), 0)::numeric AS expense
        FROM public.expenses e
        WHERE e.work_date >= (
          SELECT a.current_month - make_interval(months => p.months - 1)
          FROM anchor a CROSS JOIN params p
        )
        GROUP BY 1
      )
      SELECT to_char(ms.month_start, 'YYYY-MM') AS month,
             COALESCE(i.income, 0)  AS income,
             COALESCE(e.expense, 0) AS expense
      FROM month_span ms
      LEFT JOIN inc i ON i.m = ms.month_start
      LEFT JOIN exp e ON e.m = ms.month_start
      ORDER BY ms.month_start
    `) as Array<{ month: string; income: string | number; expense: string | number }>;

        const normalized = rows.map((r) => ({
            month: r.month,
            income: Number(r.income) || 0,
            expense: Number(r.expense) || 0,
        }));
        const totalIncome = normalized.reduce((s, r) => s + r.income, 0);
        const totalExpense = normalized.reduce((s, r) => s + r.expense, 0);

        return responseSuccess(c, "report summary", {
            range,
            summary: {
                totalIncome,
                totalExpense,
                profit: totalIncome - totalExpense,
            },
            rows: normalized,
        });
    } catch (err: any) {
        console.error("GET /reports/summary ERROR:", err);
        return responseError(c, "internal_error", 500, err?.message ?? err);
    }
});

/** =======================================
 * GET /reports/monthly?year=2025&months=3
 * หรือ /reports/monthly?thaiYear=2568&months=6
 * ส่ง blocks ต่อเดือน: incomeItems / expenseItems (group ตาม title)
 * ======================================= */
router.get("/monthly", auth, async (c) => {
    try {
        const db = getDb((c as any).env);

        const yearParam = c.req.query("year");
        const thaiYearParam = c.req.query("thaiYear");
        const monthsParam = Number(c.req.query("months") ?? 12);

        // ปีแบบ ค.ศ.
        let year: number;
        if (thaiYearParam) {
            const ty = Number(thaiYearParam);
            if (!Number.isInteger(ty)) return responseError(c, "invalid thaiYear", 400);
            year = thaiToCE(ty);
        } else {
            const y = Number(yearParam ?? new Date().getFullYear());
            if (!Number.isInteger(y)) return responseError(c, "invalid year", 400);
            year = y;
        }

        const months = Math.min(Math.max(monthsParam, 1), 12);

        // ----- ดึงเฉพาะเดือนภายใน "ปีที่ขอ" เท่านั้น -----
        // start_bound = max( end_month - (months-1), 1 Jan of that year )
        const rows = (await db/*sql*/`
      WITH params AS (
        SELECT ${months}::int AS months, ${year}::int AS year
      ),
      anchor AS (
        SELECT
          -- ถ้าปีที่ขอเป็นปีปัจจุบัน ให้สิ้นสุดที่เดือนปัจจุบัน, ไม่ใช่ → ธ.ค. ของปีนั้น
          CASE
            WHEN EXTRACT(YEAR FROM CURRENT_DATE)::int = (SELECT year FROM params)
              THEN date_trunc('month', CURRENT_DATE)::date
            ELSE make_date((SELECT year FROM params), 12, 1)::date
          END AS end_month,
          make_date((SELECT year FROM params), 1, 1)::date AS year_start
      ),
      bounds AS (
        SELECT
          GREATEST(
            a.end_month - make_interval(months => (SELECT months - 1 FROM params)),
            a.year_start
          )::date AS start_bound,
          a.end_month
        FROM anchor a
      ),
      month_span AS (
        SELECT gs::date AS month_start
        FROM bounds b
        CROSS JOIN generate_series(
          b.start_bound,
          b.end_month,
          interval '1 month'
        ) AS gs
      ),
      inc_raw AS (
        SELECT
          date_trunc('month', t.start_date)::date AS m,
          t.title,
          SUM(t.total_amount)::numeric AS amt
        FROM public.tasks t
        WHERE EXTRACT(YEAR FROM t.start_date) = (SELECT year FROM params)
        GROUP BY 1, 2
      ),
      exp_raw AS (
        SELECT
          date_trunc('month', e.work_date)::date AS m,
          e.title,
          SUM(e.amount)::numeric AS amt
        FROM public.expenses e
        WHERE EXTRACT(YEAR FROM e.work_date) = (SELECT year FROM params)
        GROUP BY 1, 2
      ),
      inc AS (
        SELECT
          m,
          COALESCE(SUM(amt),0)::numeric AS income_total,
          COUNT(*)::int AS income_count,
          json_agg(
            json_build_object('label', title, 'value', amt)
            ORDER BY amt DESC, title
          ) AS income_items
        FROM inc_raw
        GROUP BY m
      ),
      exp AS (
        SELECT
          m,
          COALESCE(SUM(amt),0)::numeric AS expense_total,
          COUNT(*)::int AS expense_count,
          json_agg(
            json_build_object('label', title, 'value', amt)
            ORDER BY amt DESC, title
          ) AS expense_items
        FROM exp_raw
        GROUP BY m
      )
      SELECT
        to_char(ms.month_start, 'YYYY-MM') AS month,
        COALESCE(i.income_total, 0)  AS income_total,
        COALESCE(e.expense_total, 0) AS expense_total,
        COALESCE(i.income_count, 0)  AS income_count,
        COALESCE(e.expense_count, 0) AS expense_count,
        COALESCE(i.income_items, '[]'::json)  AS income_items,
        COALESCE(e.expense_items, '[]'::json) AS expense_items
      FROM month_span ms
      LEFT JOIN inc i ON i.m = ms.month_start
      LEFT JOIN exp e ON e.m = ms.month_start
      ORDER BY ms.month_start
    `) as Array<{
            month: string;
            income_total: string | number;
            expense_total: string | number;
            income_count: string | number;
            expense_count: string | number;
            income_items: any | null;
            expense_items: any | null;
        }>;

        const blocks = rows.map((r) => {
            const month = r.month;
            const incomeTotal = Number(r.income_total) || 0;
            const expenseTotal = Number(r.expense_total) || 0;

            const incomeItems = (Array.isArray(r.income_items) ? r.income_items : []).map(
                (it: any) => ({
                    ...it,
                    color: "#2E7D32", // เขียว
                })
            );

            const expenseItems = (Array.isArray(r.expense_items) ? r.expense_items : []).map(
                (it: any) => ({
                    ...it,
                    color: "#C62828", // แดง
                })
            );

            return {
                month,
                monthLabel: formatThaiMonthLabel(month),
                incomeTotal,
                expenseTotal,
                incomeCount: Number(r.income_count) || 0,
                expenseCount: Number(r.expense_count) || 0,
                incomeItems,
                expenseItems,
            };
        });


        return responseSuccess(c, "monthly report", { year, months, blocks });
    } catch (err: any) {
        console.error("GET /reports/monthly ERROR:", err);
        return responseError(c, "internal_error", 500, err?.message ?? err);
    }
});

export default router;
