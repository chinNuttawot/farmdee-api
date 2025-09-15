import app from "./app";
import type { Bindings } from "./types";

// ✅ Bind fetch handler ชัดเจน
export default {
	fetch: (request: Request, env: Bindings, ctx: ExecutionContext) =>
		app.fetch(request, env, ctx),
};
