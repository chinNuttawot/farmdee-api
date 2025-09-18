import { Hono } from "hono";
import { auth } from "../middlewares/auth";
import type { SlimUser } from "../types";
import { responseSuccess, responseError } from "../utils/responseHelper";

const router = new Hono();

/** GET /me */
router.get("/", auth, (c) => {
    const u = c.get("user") as SlimUser | undefined;
    if (!u) return responseError(c, "unauthorized", 401);
    return responseSuccess(c, "me", { user: u });
});

/** GET /me/admin-only */
router.get("/admin-only", auth, (c) => {
    const u = c.get("user") as SlimUser | undefined;
    if (!u) return responseError(c, "unauthorized", 401);
    if (u.role !== "admin") return responseError(c, "forbidden", 403);
    return responseSuccess(c, "welcome admin", { user: u });
});

export default router;
