import type { Context } from "hono";

/** -------- Response Types -------- */
export interface SuccessEnvelope<T = unknown> {
  ok: true;
  message: string;
  data?: T;
}

export interface ErrorEnvelope {
  ok: false;
  error: string;      // short code/message, e.g. "invalid credentials" | "internal"
  detail?: unknown;   // optional detail object (e.g. zod flatten, stack, etc.)
}

/** -------- Helpers -------- */
export function responseSuccess<T>(
  c: Context,
  message: string,
  data?: T,
  status = 200
) {
  const payload: SuccessEnvelope<T> = {
    ok: true,
    message,
    ...(data !== undefined ? { data } : {}),
  };
  return c.json<SuccessEnvelope<T>>(payload, status);
}

/**
 * Overloads to allow:
 *  - responseError(c, "invalid credentials", 401)
 *  - responseError(c, "validation_error", 400, parsed.error.flatten())
 *  - responseError(c, parsed.error.flatten(), 400)  // auto-wrap with error="validation_error"
 */
export function responseError(
  c: Context,
  error: string,
  status?: number,
  detail?: unknown
): Response;
export function responseError(
  c: Context,
  error: Record<string, unknown>,
  status?: number
): Response;
export function responseError(
  c: Context,
  error: string | Record<string, unknown>,
  status = 400,
  detail?: unknown
) {
  let payload: ErrorEnvelope;

  if (typeof error === "string") {
    payload = {
      ok: false,
      error,
      ...(detail !== undefined ? { detail } : {}),
    };
  } else {
    // Non-string error (e.g., Zod flatten). Use a generic code and put object in detail.
    payload = {
      ok: false,
      error: "validation_error",
      detail: error,
    };
  }

  return c.json<ErrorEnvelope>(payload, status);
}
