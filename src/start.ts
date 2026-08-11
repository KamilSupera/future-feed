import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

const RATE_WINDOW = 60_000;
const RATE_MAX_PER_CLIENT = 30;
const RATE_MAX_SHARED = 300;
const SHARED_KEY = "shared";
const hits = new Map<string, { start: number; count: number }>();

function clientKey(request: Request): string {
  if (process.env["TRUST_CF_IP"] === "1") {
    const cfIp = request.headers.get("cf-connecting-ip");
    if (cfIp) return cfIp;
  }

  if (process.env["TRUST_PROXY_HEADERS"] === "1") {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
    const realIp = request.headers.get("x-real-ip");
    if (realIp) return realIp;
  }

  return SHARED_KEY;
}

function overRateLimit(request: Request): boolean {
  const key = clientKey(request);
  const limit = key === SHARED_KEY ? RATE_MAX_SHARED : RATE_MAX_PER_CLIENT;
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now - entry.start > RATE_WINDOW) {
    if (hits.size > 5000) hits.clear();
    hits.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > limit;
}

const rateLimitMiddleware = createMiddleware().server(async ({ next, request, handlerType }) => {
  if (handlerType === "serverFn" && overRateLimit(request)) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "retry-after": String(RATE_WINDOW / 1000) },
    });
  }
  return next();
});

export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware, csrfMiddleware, rateLimitMiddleware],
}));
