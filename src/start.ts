import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { RATE_WINDOW, clientKey, createRateLimiter } from "./lib/rate-limit";

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

const limiter = createRateLimiter();

const rateLimitMiddleware = createMiddleware().server(async ({ next, request, handlerType }) => {
  if (handlerType === "serverFn" && limiter.over(clientKey(request, process.env), Date.now())) {
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
