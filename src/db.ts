// src/db.ts
import { neon } from "@neondatabase/serverless";

export type Env = {
    NEON_DATABASE_URL: string;
};

export function getDb(env: Env) {
    if (!env?.NEON_DATABASE_URL) {
        throw new Error(
            "NEON_DATABASE_URL is missing. In dev, create .dev.vars. In prod, use `wrangler secret put`."
        );
    }
    return neon(env.NEON_DATABASE_URL);
}
