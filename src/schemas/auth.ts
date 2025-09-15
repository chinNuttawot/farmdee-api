import { z } from "zod";

export const RegisterSchema = z.object({
    username: z.string().min(3),
    password: z.string().min(6),
    email: z.string().email().optional(),
});

export const LoginSchema = z.object({
    username: z.string(),
    password: z.string(),
});
