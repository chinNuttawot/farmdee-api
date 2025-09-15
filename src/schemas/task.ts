// src/schemas/task.ts
import { z } from "zod";

/** ===== Enums ===== */
export const JobType = z.enum(["งานไร่", "งานซ่อม"]);
export const StatusType = z.enum(["รอทำ", "กำลังทำ", "เสร็จ"]);

/** ===== Reusable Schemas ===== */

// ยอมรับได้ทั้ง "YYYY-MM-DD" หรือ ISO string (เช่น "2025-09-15T14:41:34.865Z")
// และปล่อยเป็น string ต่อให้ไป map ที่ชั้น DB
const DateString = z
    .string()
    .min(10)
    .refine(
        (s) =>
            /^\d{4}-\d{2}-\d{2}$/.test(s) ||
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s),
        { message: "Invalid date format. Use YYYY-MM-DD or ISO 8601 (…Z)." }
    );

// รับตัวเลขที่อาจส่งมาเป็น string จาก Postman/Frontend
const IntLike = z.coerce.number().int();
const NumLike = z.coerce.number();

/** ===== Create ===== */
export const CreateTaskSchema = z
    .object({
        title: z.string().min(1),
        jobType: JobType,
        startDate: DateString,
        endDate: DateString,

        area: NumLike.optional(),
        trucks: IntLike.optional(),

        totalAmount: IntLike.nonnegative(),
        paidAmount: IntLike.nonnegative().default(0),

        note: z.string().max(2000).optional(),
        status: StatusType.optional(),
        color: z.string().optional(),
        tags: z.array(z.string()).default([]),

        // ระบุผู้รับงานได้ 2 แบบ เลือกอย่างใดอย่างหนึ่งก็ได้ (หรือไม่ใส่เลยก็ได้)
        assigneeIds: z.array(IntLike).optional(),
        assigneeUsernames: z.array(z.string()).optional(),

        // progress ไม่ต้องใส่ตอนสร้าง (ไป set 0 ที่ชั้น route/DB)
    })
    .strict();

/** ===== Update (PATCH) =====
 * - boss/admin: อนุญาตทุกฟิลด์
 * - user ปกติ: route จะกรองสิทธิ์อีกที (progress, note เท่านั้น)
 */
export const UpdateTaskSchema = CreateTaskSchema.partial()
    .extend({
        progress: z.coerce.number().min(0).max(1).optional(),
        note: z.string().max(2000).optional(), // ทับเพื่อให้แน่ใจว่ามี max
    })
    .strict();

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
