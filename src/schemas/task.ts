import { z } from "zod";
export const JobType = z.enum(["งานไร่", "งานซ่อม"]);
export const StatusType = z.enum(["รอทำ", "กำลังทำ", "เสร็จ"]);

export const CreateTaskSchema = z.object({
    title: z.string().min(1),
    jobType: JobType,
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    area: z.number().optional(),
    trucks: z.number().int().optional(),
    totalAmount: z.number().int().nonnegative(),
    paidAmount: z.number().int().nonnegative().default(0),
    note: z.string().optional(),
    status: StatusType.optional(),
    color: z.string().optional(),
    tags: z.array(z.string()).optional(),

    // ระบุผู้รับงานได้ 2 แบบ เลือกอย่างใดอย่างหนึ่งก็พอ
    assigneeIds: z.array(z.number().int()).optional(),
    assigneeUsernames: z.array(z.string()).optional(),
});

export const UpdateTaskSchema = CreateTaskSchema.partial().extend({
    // ใน PATCH จะใช้ได้แค่บางฟิลด์สำหรับลูกน้อง (จัดการใน route)
});

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
