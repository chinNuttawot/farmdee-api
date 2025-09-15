import type { Env } from "./db";

export type Bindings = Env & {
    CORS_ALLOW_ORIGIN: string;
    PBKDF2_ITER?: string;
};

// user payload ที่เซ็ตเข้า c.set('user', ...)
export type SlimUser = {
    id: number;
    username: string;
    email: string | null;
    role: "admin" | "boss" | "user";
    created_at: string;
};
