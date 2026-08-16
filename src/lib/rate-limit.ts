export const RATE_WINDOW = 60_000;
export const RATE_MAX_PER_CLIENT = 30;
export const RATE_MAX_SHARED = 300;
export const SHARED_KEY = "shared";
const MAX_TRACKED = 5_000;

export function clientKey(request: Request, env: Record<string, string | undefined>): string {
  if (env["TRUST_CF_IP"] !== "0") {
    const cfIp = request.headers.get("cf-connecting-ip");
    if (cfIp) return cfIp;
  }

  // The proxy in front appends the caller to X-Forwarded-For, so the entry it
  // added is the last one. Anything earlier came from the caller and is
  // forgeable; reading the first entry would let one client mint unlimited
  // identities and walk straight past the limiter.
  if (env["TRUST_PROXY_HEADERS"] === "1") {
    const chain = request.headers.get("x-forwarded-for")?.split(",") ?? [];
    const nearest = chain[chain.length - 1]?.trim();
    if (nearest) return nearest;
    const realIp = request.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }

  return SHARED_KEY;
}

export function createRateLimiter(maxTracked = MAX_TRACKED) {
  const hits = new Map<string, { start: number; count: number }>();

  return {
    over(key: string, now: number): boolean {
      const limit = key === SHARED_KEY ? RATE_MAX_SHARED : RATE_MAX_PER_CLIENT;
      const entry = hits.get(key);

      if (entry && now - entry.start <= RATE_WINDOW) {
        entry.count++;
        return entry.count > limit;
      }

      hits.delete(key);
      while (hits.size >= maxTracked) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
      }
      hits.set(key, { start: now, count: 1 });
      return false;
    },
    get size() {
      return hits.size;
    },
  };
}
