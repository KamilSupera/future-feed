export type NewsArticle = {
  id: string;
  title: string;
  description: string | null;
  link: string;
  image: string | null;
  source: string;
  category: string;
  country: string;
  publishedAt: string | null;
};

export type NewsFeed = {
  articles: NewsArticle[];
  nextPage: string | null;
  error: string | null;
};

export const CATEGORIES = [
  "all",
  "world",
  "technology",
  "science",
  "business",
  "politics",
  "environment",
  "health",
] as const;

export const ALLOWED_CATEGORIES = new Set<string>(CATEGORIES);
export const PAGE_TOKEN = /^\d{1,32}$/;
export const SIGNED_PAGE = /^\d{1,32}~[0-9a-f]{16}$/;

export const CACHE_TTL = 30 * 60_000;
export const ERROR_TTL = 60_000;
export const REFRESH_INTERVAL = 60 * 60_000;
export const MAX_CACHE_ENTRIES = 200;
export const DAILY_UPSTREAM_CAP = 150;
export const MAX_DESCRIPTION = 200;

const BLOCKED_SOURCES = new Set(["reflector"]);

export function createCache(max = MAX_CACHE_ENTRIES) {
  const entries = new Map<string, { at: number; feed: NewsFeed }>();
  return {
    get(key: string, now: number): NewsFeed | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      return now - hit.at < (hit.feed.error ? ERROR_TTL : CACHE_TTL) ? hit.feed : undefined;
    },
    stale(key: string): NewsFeed | undefined {
      return entries.get(key)?.feed;
    },
    set(key: string, feed: NewsFeed, now: number): NewsFeed {
      entries.delete(key);
      while (entries.size >= max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(key, { at: now, feed });
      return feed;
    },
    get size() {
      return entries.size;
    },
  };
}

export function createBudget(cap = DAILY_UPSTREAM_CAP) {
  let day = "";
  let used = 0;
  return {
    available(now: number): boolean {
      const today = new Date(now).toISOString().slice(0, 10);
      if (day !== today) {
        day = today;
        used = 0;
      }
      return used < cap;
    },
    spend(): void {
      used++;
    },
    get used() {
      return used;
    },
  };
}

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function signingKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keyCache.set(secret, key);
  }
  return key;
}

export async function signPageToken(token: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    encoder.encode(token),
  );
  return Array.from(new Uint8Array(signature).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function sealPageToken(token: unknown, secret: string): Promise<string | null> {
  const value = String(token ?? "");
  if (!PAGE_TOKEN.test(value)) return null;
  return `${value}~${await signPageToken(value, secret)}`;
}

export async function openPageToken(signed: string, secret: string): Promise<string | null> {
  const [token, signature] = signed.split("~");
  if (!token || !signature) return null;
  return matches(signature, await signPageToken(token, secret)) ? token : null;
}

export function matches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function clip(text: string | null): string | null {
  if (!text || text.length <= MAX_DESCRIPTION) return text;
  return `${text.slice(0, MAX_DESCRIPTION).trimEnd()}…`;
}

export function externalUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function imageUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeArticles(results: Array<Record<string, unknown>>): NewsArticle[] {
  return results
    .filter((r) => !BLOCKED_SOURCES.has(String(r["source_id"] ?? "").toLowerCase()))
    .map((r, i) => ({
      id: String(r["article_id"] ?? i),
      title: String(r["title"] ?? "Untitled transmission"),
      description: clip((r["description"] as string | null) ?? null),
      link: externalUrl(r["link"]) ?? "#",
      image: imageUrl(r["image_url"]),
      source: String(r["source_name"] ?? r["source_id"] ?? "UNKNOWN"),
      category: Array.isArray(r["category"]) ? String((r["category"] as string[])[0]) : "world",
      country: Array.isArray(r["country"]) ? String((r["country"] as string[])[0]) : "global",
      publishedAt: (r["pubDate"] as string | null) ?? null,
    }));
}
