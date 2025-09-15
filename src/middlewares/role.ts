import type { Context, Next } from "hono";

export function requireRole(roles: Array<'admin' | 'boss' | 'user'>) {
    return async (c: Context, next: Next) => {
        const u = c.get("user") as { id: number; username: string; role?: string };
        if (!u?.role || !roles.includes(u.role as any)) {
            return c.json({ error: "forbidden" }, 403);
        }
        await next();
    };
}

export function isBossOrAdmin(u: { role?: string }) {
    return u?.role === 'boss' || u?.role === 'admin';
}
