// src/index.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getDb, Env } from "./db";
import { hashPassword, verifyPassword, genToken } from "./crypto";
import { z } from "zod";

type Bindings = Env & {
	CORS_ALLOW_ORIGIN: string;
	PBKDF2_ITER?: string; // ถ้าจะอ่านไปใช้ใน crypto ก็มีไว้ได้
};

const app = new Hono<{ Bindings: Bindings }>();

// ============ Global error handlers ============
app.onError((err, c) => {
	console.error("UNCAUGHT ERROR:", err);
	return c.json(
		{ error: "internal_error", detail: (err as any)?.message ?? String(err) },
		500
	);
});
app.notFound((c) => c.json({ error: "not_found" }, 404));

// ============ CORS ============
// หมายเหตุ: ถ้าคุณต้องการ credentials (เช่น cookie) ให้ตั้ง
// CORS_ALLOW_ORIGIN เป็นโดเมนจริง (ไม่ใช่ "*") แล้วเปลี่ยน credentials เป็น true
app.use(
	"*",
	cors({
		origin: (origin, c) => c.env?.CORS_ALLOW_ORIGIN || origin || "*",
		credentials: false, // ใช้ false เมื่อ origin เป็น "*"
		allowHeaders: ["Content-Type", "Authorization"],
		allowMethods: ["GET", "POST", "OPTIONS"],
		maxAge: 86400,
	})
);

// ---------- Helpers ----------
function getIP(c: any) {
	return c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "";
}
function getUA(c: any) {
	return c.req.header("user-agent") || "";
}
function nowPlusDays(days: number) {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().replace("T", " ").replace("Z", "");
}
function toPgTimestamp(date: Date) {
	return date.toISOString().replace("T", " ").replace("Z", "");
}

// ---------- Schemas ----------
const RegisterSchema = z.object({
	username: z.string().min(3),
	password: z.string().min(6),
	email: z.string().email().optional(),
});

const LoginSchema = z.object({
	username: z.string(),
	password: z.string(),
});

// ============ Debug endpoints ============
app.get("/__debug/env", (c) => {
	const hasNeon = Boolean(c.env?.NEON_DATABASE_URL);
	const allow = c.env?.CORS_ALLOW_ORIGIN ?? "(unset)";
	const iter = c.env?.PBKDF2_ITER ?? "(unset)";
	return c.json({
		NEON_DATABASE_URL: hasNeon ? "SET" : "MISSING",
		CORS_ALLOW_ORIGIN: allow,
		PBKDF2_ITER: iter,
	});
});

app.get("/__db/ping", async (c) => {
	try {
		const db = getDb(c.env);
		const rows = await db`SELECT 1 AS ok`;
		return c.json({ ok: rows?.[0]?.ok === 1 });
	} catch (e: any) {
		console.error("DB PING ERROR:", e);
		return c.json({ error: e?.message ?? String(e) }, 500);
	}
});

// ---------- Routes ----------

// health
app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// register
app.post("/auth/register", async (c) => {
	try {
		const db = getDb(c.env);

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid or missing JSON body" }, 400);
		}

		const parsed = RegisterSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: parsed.error.flatten() }, 400);
		}
		const { username, password, email } = parsed.data;

		// ตรวจซ้ำ
		const exists = await db`SELECT id FROM users WHERE username = ${username}`;
		if (exists.length > 0) {
			return c.json({ error: "username already exists" }, 409);
		}

		const pw = await hashPassword(password); // crypto.ts ใช้ PBKDF2 100k
		const rows = await db<{ id: number }>`
      INSERT INTO users (username, password_hash, email)
      VALUES (${username}, ${pw}, ${email ?? null})
      RETURNING id`;

		return c.json({ message: "register success", userId: rows[0].id });
	} catch (e: any) {
		console.error("REGISTER ERROR:", e);
		return c.json({ error: "internal", detail: e?.message ?? String(e) }, 500);
	}
});

// login -> สร้าง session token
app.post("/auth/login", async (c) => {
	try {
		const db = getDb(c.env);

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid or missing JSON body" }, 400);
		}

		const parsed = LoginSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: parsed.error.flatten() }, 400);
		}
		const { username, password } = parsed.data;

		const rows = await db<{ id: number; password_hash: string }>`
      SELECT id, password_hash FROM users WHERE username = ${username}`;
		if (rows.length === 0) {
			return c.json({ error: "invalid credentials" }, 401);
		}

		const user = rows[0];
		const ok = await verifyPassword(password, user.password_hash);
		if (!ok) return c.json({ error: "invalid credentials" }, 401);

		const token = genToken(32);
		const ua = getUA(c);
		const ip = getIP(c);
		const expires = nowPlusDays(7); // อายุ 7 วัน

		await db`
      INSERT INTO sessions (user_id, token, user_agent, ip, expires_at)
      VALUES (${user.id}, ${token}, ${ua}, ${ip}, ${expires})
    `;

		return c.json({
			message: "login success",
			token,
			token_type: "Bearer",
			expires_at: expires,
		});
	} catch (e: any) {
		console.error("LOGIN ERROR:", e);
		return c.json({ error: "internal", detail: e?.message ?? String(e) }, 500);
	}
});

// middleware เช็ค token
async function auth(c: any, next: any) {
	try {
		const db = getDb(c.env);
		const authHeader = c.req.header("authorization") || "";
		const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
		if (!token) return c.json({ error: "missing token" }, 401);

		const rows = await db<{
			user_id: number;
			expires_at: string;
			revoked_at: string | null;
		}>`SELECT user_id, expires_at, revoked_at FROM sessions WHERE token = ${token}`;
		if (rows.length === 0) return c.json({ error: "invalid token" }, 401);
		const sess = rows[0];

		if (sess.revoked_at) return c.json({ error: "token revoked" }, 401);
		const now = new Date();
		if (now > new Date(sess.expires_at + "Z")) return c.json({ error: "token expired" }, 401);

		// โหลดโปรไฟล์แบบย่อ
		const urows = await db<{
			id: number;
			username: string;
			email: string | null;
			created_at: string;
		}>`SELECT id, username, email, created_at FROM users WHERE id = ${sess.user_id}`;
		if (urows.length === 0) return c.json({ error: "user not found" }, 401);

		c.set("user", urows[0]);
		await next();
	} catch (e: any) {
		console.error("AUTH ERROR:", e);
		return c.json({ error: "internal", detail: e?.message ?? String(e) }, 500);
	}
}

// me
app.get("/me", auth, async (c) => {
	const user = c.get("user");
	return c.json({ user });
});

// logout -> revoke token ปัจจุบัน
app.post("/auth/logout", auth, async (c) => {
	try {
		const db = getDb(c.env);
		const authHeader = c.req.header("authorization") || "";
		const token = authHeader.slice(7).trim();
		await db`UPDATE sessions SET revoked_at = ${toPgTimestamp(new Date())} WHERE token = ${token}`;
		return c.json({ message: "logout success" });
	} catch (e: any) {
		console.error("LOGOUT ERROR:", e);
		return c.json({ error: "internal", detail: e?.message ?? String(e) }, 500);
	}
});

// (option) logout all sessions ของผู้ใช้
app.post("/auth/logout-all", auth, async (c) => {
	try {
		const db = getDb(c.env);
		const user = c.get("user") as { id: number };
		await db`
      UPDATE sessions
      SET revoked_at = ${toPgTimestamp(new Date())}
      WHERE user_id = ${user.id} AND revoked_at IS NULL`;
		return c.json({ message: "logout all success" });
	} catch (e: any) {
		console.error("LOGOUT-ALL ERROR:", e);
		return c.json({ error: "internal", detail: e?.message ?? String(e) }, 500);
	}
});

// ✅ Bind fetch handler ชัดเจน (กัน Wrangler บางเวอร์ชันไม่เห็น handler)
export default {
	fetch: (request: Request, env: Bindings, ctx: ExecutionContext) =>
		app.fetch(request, env, ctx),
};
