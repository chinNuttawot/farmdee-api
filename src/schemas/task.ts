import { z } from "zod";

/** ===== Enums ===== */
export const JobType = z.enum(["งานไร่", "งานซ่อม"]);
export const StatusType = z.enum(["Pending", "InProgress", "Done"]);

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

// เงินทศนิยม: ยอมรับ number/string, >= 0 และทศนิยมไม่เกิน 2 ตำแหน่ง
const Money2 = z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.coerce
        .number()
        .nonnegative()
        .refine((v) => Math.round(v * 100) === v * 100, {
            message: "must have at most 2 decimal places",
        })
);

// แปลง "" → undefined ก่อน validate
const OptInt = z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.number().int().nonnegative()
);
const OptNum = z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.number().nonnegative()
);

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

        // ใช้ Opt* เพื่อให้ "" ไม่ทำให้เป็น 0
        area: OptNum.optional(),
        trucks: OptInt.optional(),

        // รองรับทศนิยม
        totalAmount: Money2.default(0),
        paidAmount: Money2.default(0),

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

    // งานไร่: ต้องกรอกอย่างน้อย 1: area หรือ trucks
    if (data.jobType === "งานไร่") {
        if (data.area === undefined && data.trucks === undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "งานไร่ ต้องกรอกอย่างน้อย 1 อย่าง: จำนวนไร่ หรือ จำนวนรถ",
                path: ["area"],
            });
        }
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

        if (data.jobType === "งานไร่") {
            if (data.area === undefined && data.trucks === undefined) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "งานไร่ ต้องกรอกอย่างน้อย 1 อย่าง: จำนวนไร่ หรือ จำนวนรถ",
                    path: ["area"],
                });
            }
        }
    });

/** ===== Types ===== */
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type AssigneeConfigInput = z.infer<typeof AssigneeConfigSchema>;
