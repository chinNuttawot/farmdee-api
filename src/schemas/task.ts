// src/schemas/task.ts
import { z } from "zod";

/** ===== Enums ===== */
export const JobType = z.enum(["งานไร่", "งานซ่อม"]);
export const StatusType = z.enum(["รอทำ", "กำลังทำ", "เสร็จ"]);

/** ===== Reusable Schemas ===== */
const DateString = z
    .string()
    .min(10)
    .refine(
        (s) =>
            /^\d{4}-\d{2}-\d{2}$/.test(s) ||
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ||
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+\-]\d{2}:\d{2})$/.test(s),
        { message: "Invalid date format. Use YYYY-MM-DD or ISO 8601." }
    );

const IntLike = z.coerce.number().int();
const NumLike = z.coerce.number();

/** ===== Assignee Config ===== */
export const AssigneeConfigSchema = z
    .object({
        userId: IntLike.optional(),
        username: z.string().min(1).optional(),
        useDefault: z.coerce.boolean().optional(),
        ratePerRai: NumLike.nullable().optional(),
        repairRate: NumLike.nullable().optional(),
        dailyRate: NumLike.nullable().optional(),
    })
    .refine((o) => !!o.userId || !!o.username, {
        message: "assigneeConfigs[]: require userId or username",
        path: ["userId"],
    });

/** ===== Base Create (แค่โครง object) ===== */
const CreateTaskBase = z
    .object({
        title: z.string().min(1),
        jobType: JobType,
        startDate: DateString,
        endDate: DateString,

        area: NumLike.nonnegative().optional(),
        trucks: IntLike.nonnegative().optional(),

        totalAmount: IntLike.nonnegative(),
        paidAmount: IntLike.nonnegative().default(0),

        note: z.string().max(2000).optional(),
        status: StatusType.optional(),
        color: z.string().optional(),
        tags: z.array(z.string()).default([]),

        assigneeConfigs: z.array(AssigneeConfigSchema).optional(),
        assigneeIds: z.array(IntLike).optional(),
        assigneeUsernames: z.array(z.string()).optional(),
    })
    .strict();

/** ===== Create ===== */
export const CreateTaskSchema = CreateTaskBase.superRefine((data, ctx) => {
    // endDate >= startDate
    if (data.startDate && data.endDate) {
        const s = new Date(data.startDate).getTime();
        const e = new Date(data.endDate).getTime();
        if (!Number.isNaN(s) && !Number.isNaN(e) && e < s) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "endDate must be the same day or after startDate",
                path: ["endDate"],
            });
        }
    }
    // paidAmount <= totalAmount
    if (
        typeof data.totalAmount === "number" &&
        typeof data.paidAmount === "number" &&
        data.paidAmount > data.totalAmount
    ) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "paidAmount cannot exceed totalAmount",
            path: ["paidAmount"],
        });
    }
});

/** ===== Update (PATCH) ===== */
export const UpdateTaskSchema = CreateTaskBase.partial()
    .extend({
        progress: z.coerce.number().min(0).max(1).optional(),
        note: z.string().max(2000).optional(),
        assigneeConfigs: z.array(AssigneeConfigSchema).optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
        if (data.startDate && data.endDate) {
            const s = new Date(data.startDate).getTime();
            const e = new Date(data.endDate).getTime();
            if (!Number.isNaN(s) && !Number.isNaN(e) && e < s) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "endDate must be the same day or after startDate",
                    path: ["endDate"],
                });
            }
        }
        if (
            typeof data.totalAmount === "number" &&
            typeof data.paidAmount === "number" &&
            data.paidAmount > data.totalAmount
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "paidAmount cannot exceed totalAmount",
                path: ["paidAmount"],
            });
        }
    });

/** ===== Types ===== */
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type AssigneeConfigInput = z.infer<typeof AssigneeConfigSchema>;
