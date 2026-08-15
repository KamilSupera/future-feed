import { createServerFn } from "@tanstack/react-start";

import {
  ALLOWED_CATEGORIES,
  CACHE_TTL,
  SIGNED_PAGE,
  createBudget,
  createCache,
  normalizeArticles,
  openPageToken,
  sealPageToken,
  type NewsFeed,
} from "./news.core";

export { CATEGORIES, REFRESH_INTERVAL, type NewsArticle, type NewsFeed } from "./news.core";

// ponytail: cache and budget live in isolate memory, so the cap is per isolate,
// not global. `cf.cacheTtl` below collapses that to one upstream call per colo
// per TTL. A hard global cap needs a KV or Durable Object binding.
const cache = createCache();
const budget = createBudget();

function signingSecret(): string | undefined {
  return process.env["PAGE_TOKEN_SECRET"] || process.env["NEWSDATA_API_KEY"];
}

export const getWorldNews = createServerFn({ method: "GET" })
  .validator((data: { category?: string; page?: string | undefined } | undefined) => {
    const page = data?.page;
    return {
      category:
        data?.category && data.category !== "all" && ALLOWED_CATEGORIES.has(data.category)
          ? data.category
          : undefined,
      page: page && SIGNED_PAGE.test(page) ? page : undefined,
      badPage: Boolean(page) && !(page && SIGNED_PAGE.test(page)),
    };
  })
  .handler(async ({ data }): Promise<NewsFeed> => {
    const apiKey = process.env["NEWSDATA_API_KEY"];
    if (!apiKey) return { articles: [], nextPage: null, error: "NO_KEY" };
    if (data.badPage) return { articles: [], nextPage: null, error: "BAD_PAGE" };

    const secret = signingSecret()!;
    let pageToken: string | undefined;
    if (data.page) {
      const opened = await openPageToken(data.page, secret);
      if (!opened) return { articles: [], nextPage: null, error: "BAD_PAGE" };
      pageToken = opened;
    }

    const cacheKey = `${data.category ?? "all"}:${pageToken ?? "1"}`;
    const fresh = cache.get(cacheKey, Date.now());
    if (fresh) return fresh;

    if (!budget.available(Date.now())) {
      return cache.stale(cacheKey) ?? { articles: [], nextPage: null, error: "QUOTA" };
    }

    const remember = (feed: NewsFeed) => cache.set(cacheKey, feed, Date.now());

    const url = new URL("https://newsdata.io/api/1/latest");
    url.searchParams.set("language", "en");
    if (data.category) url.searchParams.set("category", data.category);
    if (pageToken) url.searchParams.set("page", pageToken);

    try {
      const res = await fetch(url.toString(), {
        headers: { "X-ACCESS-KEY": apiKey },
        cf: { cacheTtl: CACHE_TTL / 1000, cacheEverything: true },
      } as RequestInit);

      if (res.headers.get("cf-cache-status") !== "HIT") budget.spend();

      const json = (await res.json()) as {
        status?: string;
        results?: Array<Record<string, unknown>>;
        nextPage?: string | null;
      };

      if (!res.ok || json.status === "error") {
        return remember({ articles: [], nextPage: null, error: "UPSTREAM" });
      }

      return remember({
        articles: normalizeArticles(json.results ?? []),
        nextPage: json.nextPage ? await sealPageToken(json.nextPage, secret) : null,
        error: null,
      });
    } catch {
      return remember({ articles: [], nextPage: null, error: "NETWORK" });
    }
  });
