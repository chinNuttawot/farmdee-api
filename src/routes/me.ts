import { Hono } from "hono";
import { auth } from "../middlewares/auth";
import { SlimUser } from "../types";

const router = new Hono();

// GET /me
router.get("/", auth, async (c) => {
    const user = c.get("user");
    return c.json({ user });
});


router.get("/admin-only", auth, (c) => {
    const u = c.get("user") as SlimUser;
    if (u.role !== "admin") return c.json({ error: "forbidden" }, 403);
    return c.json({ message: "Welcome admin!" });
});

export default router;
