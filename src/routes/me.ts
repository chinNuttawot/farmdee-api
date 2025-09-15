import { Hono } from "hono";
import { auth } from "../middlewares/auth";

const router = new Hono();

// GET /me
router.get("/", auth, async (c) => {
    const user = c.get("user");
    return c.json({ user });
});

export default router;
