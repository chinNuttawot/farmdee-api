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

/** ===== Assignee Config =====
 * ใช้ตอนส่งรายละเอียดผู้รับงานแบบกำหนด rate เฉพาะคน
 * ต้องมีอย่างน้อย userId หรือ username อย่างใดอย่างหนึ่ง
 */
export const AssigneeConfigSchema = z
    .object({
        userId: IntLike.optional(),
        username: z.string().min(1).optional(),
        useDefault: z.coerce.boolean().optional(), // ไม่ส่งมาถือว่า true
        ratePerRai: NumLike.nullable().optional(),
        repairRate: NumLike.nullable().optional(),
        dailyRate: NumLike.nullable().optional(),
    })
    .refine((o) => !!o.userId || !!o.username, {
        message: "assigneeConfigs[]: require userId or username",
        path: ["userId"], // ชี้ตำแหน่ง error ให้เข้าใจง่าย
    });

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

        // --- ระบุผู้รับงานได้ 3 แบบ: ---
        // 1) โหมดใหม่: รายการ config ต่อคน
        assigneeConfigs: z.array(AssigneeConfigSchema).optional(),

        // 2) โหมดเดิม: ตาม id (use_default = true)
        assigneeIds: z.array(IntLike).optional(),

        // 3) โหมดเดิม: ตาม username (use_default = true)
        assigneeUsernames: z.array(z.string()).optional(),

        // progress ไม่ต้องใส่ตอนสร้าง (ไป set 0 ที่ชั้น route/DB)
    })
    .strict()
// (ถ้าต้องการบังคับว่า ห้ามส่งทั้ง assigneeConfigs และแบบเดิมพร้อมกัน ให้เปิด superRefine นี้)
// .superRefine((data, ctx) => {
//   const hasConfigs = !!data.assigneeConfigs?.length;
//   const hasLegacy =
//     !!data.assigneeIds?.length || !!data.assigneeUsernames?.length;
//   if (hasConfigs && hasLegacy) {
//     ctx.addIssue({
//       code: z.ZodIssueCode.custom,
//       message:
//         "ส่งผู้รับงานได้แบบเดียว: เลือก assigneeConfigs หรือ assigneeIds/assigneeUsernames เท่านั้น",
//       path: ["assigneeConfigs"],
//     });
//   }
// });

/** ===== Update (PATCH) =====
 * - boss/admin: อนุญาตทุกฟิลด์ (route จะกันเงินเอง)
 * - user ปกติ: route จะกรองสิทธิ์อีกที (progress, note เท่านั้น)
 */
export const UpdateTaskSchema = CreateTaskSchema.partial()
    .extend({
        progress: z.coerce.number().min(0).max(1).optional(),
        note: z.string().max(2000).optional(), // ทับเพื่อให้แน่ใจว่ามี max
        // ย้ำว่ารองรับ assigneeConfigs ตอนแก้ไขด้วย
        assigneeConfigs: z.array(AssigneeConfigSchema).optional(),
    })
    .strict();

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type AssigneeConfigInput = z.infer<typeof AssigneeConfigSchema>;
