import { Hono } from "hono";
import { getDb } from "../db";
import { auth } from "../middlewares/auth";
import { responseSuccess, responseError } from "../utils/responseHelper";
import { z } from "zod";

const router = new Hono();

const UpdatePaySchema = z.object({
    pay_type: z.enum(["per_rai", "daily"]),
    default_rate_per_rai: z.number().min(0).optional(),
    default_repair_rate: z.number().min(0).optional(),
    default_daily_rate: z.number().min(0).optional(),
    name_car: z.string().optional().nullable(),
});

/** ===== GET /users (รายชื่อพนักงาน) ===== */
router.get("/", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const q = c.req.query();
        const role = q.role ?? null;
        // ดึงรายชื่อพนักงานทั้งหมด
        const rows = await db/*sql*/`
      SELECT 
        id, 
        username, 
        email, 
        role, 
        created_at, 
        name_car As namecar, 
        pay_type, 
        default_rate_per_rai As rate_Per_Rai, 
        default_repair_rate As repair_Rate,
        default_daily_rate As daily_Rate,
        full_name
      FROM users
      WHERE (${role}::text IS NULL OR role = ${role}::text)
      ORDER BY username ASC
    `;

        return responseSuccess(c, "fetched users", {
            count: rows.length,
            items: rows,
        });
    } catch (err: any) {
        return responseError(
            c,
            "internal_error",
            500,
            err?.message ?? String(err)
        );
    }
});

router.put("/:id/pay", auth, async (c) => {
    try {
        const db = getDb((c as any).env);
        const id = Number(c.req.param("id"));
        if (!id) {
            return responseError(c, "invalid_id", 400, "invalid user id");
        }

        const body = await c.req.json();
        const parsed = UpdatePaySchema.parse(body);

        const rows = await db/*sql*/`
      UPDATE users
      SET
        pay_type = ${parsed.pay_type},
        default_rate_per_rai = ${parsed.default_rate_per_rai ?? null},
        default_repair_rate = ${parsed.default_repair_rate ?? null},
        default_daily_rate = ${parsed.default_daily_rate ?? null},
        name_car = ${parsed.name_car ?? null},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, username, pay_type, default_rate_per_rai, default_repair_rate, default_daily_rate, name_car
    `;

        if (rows.length === 0) {
            return responseError(c, "not_found", 404, "user not found");
        }

        return responseSuccess(c, "user pay updated", rows[0]);
    } catch (err: any) {
        return responseError(
            c,
            "internal_error",
            500,
            err?.message ?? String(err)
        );
    }
});

export default router;
