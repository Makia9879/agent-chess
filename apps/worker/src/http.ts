import type { ErrorResponse } from "@chess-room/shared";

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {})
    }
  });
}

export function error(code: string, message: string, status = 400): Response {
  const body: ErrorResponse = { error: { code, message } };
  return json(body, { status });
}

export function withCors(response: Response, origin: string | null, allowOrigins: string[]): Response {
  const headers = new Headers(response.headers);
  if (origin && (allowOrigins.includes(origin) || allowOrigins.includes("*"))) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "origin");
  }
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,authorization");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError("invalid_json", "request body is not valid JSON", 400);
  }
}

export class HttpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

export function toErrorResponse(errorValue: unknown): Response {
  if (errorValue instanceof HttpError) {
    return error(errorValue.code, errorValue.message, errorValue.status);
  }
  if (errorValue instanceof Error && errorValue.message.includes("DATABASE_URL")) {
    return error("config_error", errorValue.message, 500);
  }
  return error("internal_error", "unexpected internal error", 500);
}
