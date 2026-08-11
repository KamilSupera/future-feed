import { createServerFn } from "@tanstack/react-start";

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

const ALLOWED_CATEGORIES = new Set<string>(CATEGORIES);
const SIGNED_PAGE = /^\d{1,32}~[0-9a-f]{16}$/;

const CACHE_TTL = 30 * 60_000;
const ERROR_TTL = 60_000;
const MAX_CACHE_ENTRIES = 200;
const DAILY_UPSTREAM_CAP = 150;

const cache = new Map<string, { at: number; feed: NewsFeed }>();
let budget = { day: "", used: 0 };

function withinBudget(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (budget.day !== today) budget = { day: today, used: 0 };
  if (budget.used >= DAILY_UPSTREAM_CAP) return false;
  budget.used++;
  return true;
}

const encoder = new TextEncoder();
let signingKey: Promise<CryptoKey> | undefined;

function getSigningKey(secret: string): Promise<CryptoKey> {
  signingKey ??= crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return signingKey;
}

async function signPageToken(token: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await getSigningKey(secret),
    encoder.encode(token),
  );
  return Array.from(new Uint8Array(signature).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function matches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const BLOCKED_SOURCES = new Set(["reflector"]);

const MAX_DESCRIPTION = 200;

function clip(text: string | null): string | null {
  if (!text || text.length <= MAX_DESCRIPTION) return text;
  return `${text.slice(0, MAX_DESCRIPTION).trimEnd()}…`;
}

function httpUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export const getWorldNews = createServerFn({ method: "GET" })
  .validator((data: { category?: string; page?: string | undefined } | undefined) => ({
    category:
      data?.category && data.category !== "all" && ALLOWED_CATEGORIES.has(data.category)
        ? data.category
        : undefined,
    page: data?.page && SIGNED_PAGE.test(data.page) ? data.page : undefined,
  }))
  .handler(async ({ data }): Promise<NewsFeed> => {
    const apiKey = process.env["NEWSDATA_API_KEY"];
    if (!apiKey) {
      return { articles: [], nextPage: null, error: "NO_KEY" };
    }

    let pageToken: string | undefined;
    if (data.page) {
      const [token, signature] = data.page.split("~");
      if (!token || !signature || !matches(signature, await signPageToken(token, apiKey))) {
        return { articles: [], nextPage: null, error: "BAD_PAGE" };
      }
      pageToken = token;
    }

    const cacheKey = `${data.category ?? "all"}:${pageToken ?? "1"}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < (cached.feed.error ? ERROR_TTL : CACHE_TTL)) {
      return cached.feed;
    }

    if (!withinBudget()) return cached?.feed ?? { articles: [], nextPage: null, error: "QUOTA" };

    const remember = (feed: NewsFeed): NewsFeed => {
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(cacheKey, { at: Date.now(), feed });
      return feed;
    };

    const url = new URL("https://newsdata.io/api/1/latest");
    url.searchParams.set("language", "en");
    if (data.category) url.searchParams.set("category", data.category);
    if (pageToken) url.searchParams.set("page", pageToken);

    try {
      const res = await fetch(url.toString(), { headers: { "X-ACCESS-KEY": apiKey } });
      const json = (await res.json()) as {
        status?: string;
        results?: Array<Record<string, unknown>>;
        nextPage?: string | null;
        results_message?: string;
        message?: string;
      };

      if (!res.ok || json.status === "error") {
        return remember({ articles: [], nextPage: null, error: "UPSTREAM" });
      }

      const articles: NewsArticle[] = (json.results ?? [])
        .filter((r) => !BLOCKED_SOURCES.has(String(r["source_id"] ?? "").toLowerCase()))
        .map((r, i) => ({
          id: String(r["article_id"] ?? i),
          title: String(r["title"] ?? "Untitled transmission"),
          description: clip((r["description"] as string | null) ?? null),
          link: httpUrl(r["link"]) ?? "#",
          image: httpUrl(r["image_url"]),
          source: String(r["source_name"] ?? r["source_id"] ?? "UNKNOWN"),
          category: Array.isArray(r["category"]) ? String((r["category"] as string[])[0]) : "world",
          country: Array.isArray(r["country"]) ? String((r["country"] as string[])[0]) : "global",
          publishedAt: (r["pubDate"] as string | null) ?? null,
        }));

      const nextPage = json.nextPage
        ? `${json.nextPage}~${await signPageToken(json.nextPage, apiKey)}`
        : null;

      return remember({ articles, nextPage, error: null });
    } catch {
      return remember({ articles: [], nextPage: null, error: "NETWORK" });
    }
  });
