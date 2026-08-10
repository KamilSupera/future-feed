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
  error: string | null;
};

export const getWorldNews = createServerFn({ method: "GET" })
  .inputValidator((data: { category?: string } | undefined) => ({
    category: data?.category && data.category !== "all" ? data.category : undefined,
  }))
  .handler(async ({ data }): Promise<NewsFeed> => {
    const apiKey = process.env["NEWSDATA_API_KEY"];
    if (!apiKey) {
      return { articles: [], error: "NO_KEY" };
    }

    const url = new URL("https://newsdata.io/api/1/latest");
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("language", "en");
    if (data.category) url.searchParams.set("category", data.category);

    try {
      const res = await fetch(url.toString());
      const json = (await res.json()) as {
        status?: string;
        results?: Array<Record<string, unknown>>;
        results_message?: string;
        message?: string;
      };

      if (!res.ok || json.status === "error") {
        return { articles: [], error: json.message ?? json.results_message ?? "UPSTREAM" };
      }

      const articles: NewsArticle[] = (json.results ?? []).map((r, i) => ({
        id: String(r["article_id"] ?? i),
        title: String(r["title"] ?? "Untitled transmission"),
        description: (r["description"] as string | null) ?? null,
        link: String(r["link"] ?? "#"),
        image: (r["image_url"] as string | null) ?? null,
        source: String(r["source_name"] ?? r["source_id"] ?? "UNKNOWN"),
        category: Array.isArray(r["category"]) ? String((r["category"] as string[])[0]) : "world",
        country: Array.isArray(r["country"]) ? String((r["country"] as string[])[0]) : "global",
        publishedAt: (r["pubDate"] as string | null) ?? null,
      }));

      return { articles, error: null };
    } catch {
      return { articles: [], error: "NETWORK" };
    }
  });