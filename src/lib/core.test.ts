import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SIGNED_PAGE,
  clip,
  createBudget,
  createCache,
  externalUrl,
  imageUrl,
  matches,
  normalizeArticles,
  openPageToken,
  sealPageToken,
  type NewsFeed,
} from "./news.core.ts";
import {
  RATE_MAX_PER_CLIENT,
  RATE_MAX_SHARED,
  SHARED_KEY,
  clientKey,
  createRateLimiter,
} from "./rate-limit.ts";

const SECRET = "test-secret";
const feed = (error: string | null = null): NewsFeed => ({ articles: [], nextPage: null, error });

describe("page tokens", () => {
  it("round-trips a token it sealed itself", async () => {
    const sealed = await sealPageToken("1786754756517588184", SECRET);
    assert.ok(sealed);
    assert.match(sealed, SIGNED_PAGE);
    assert.equal(await openPageToken(sealed, SECRET), "1786754756517588184");
  });

  it("refuses a token signed with a different secret", async () => {
    const sealed = (await sealPageToken("123", SECRET))!;
    assert.equal(await openPageToken(sealed, "other-secret"), null);
  });

  it("refuses a tampered payload", async () => {
    const sealed = (await sealPageToken("123", SECRET))!;
    const [, signature] = sealed.split("~");
    assert.equal(await openPageToken(`999~${signature}`, SECRET), null);
  });

  it("refuses to seal anything that is not a bare page number", async () => {
    for (const bad of ["1;DROP", "abc", "1 2", "", "-1", "1".repeat(33)]) {
      assert.equal(await sealPageToken(bad, SECRET), null, bad);
    }
  });

  it("rejects upstream-parameter injection at the regex boundary", () => {
    for (const bad of [
      "1~short",
      "1&api_key=x~0123456789abcdef",
      "../~0123456789abcdef",
      "1~ZZZZZZZZZZZZZZZZ",
    ]) {
      assert.equal(SIGNED_PAGE.test(bad), false, bad);
    }
  });

  it("compares in a length-checked, branch-free way", () => {
    assert.equal(matches("abcd", "abcd"), true);
    assert.equal(matches("abcd", "abce"), false);
    assert.equal(matches("abcd", "abc"), false);
  });
});

describe("url hardening", () => {
  it("upgrades http images to https so they survive a TLS page", () => {
    assert.equal(imageUrl("http://cdn.example.com/a.jpg"), "https://cdn.example.com/a.jpg");
    assert.equal(imageUrl("https://cdn.example.com/a.jpg"), "https://cdn.example.com/a.jpg");
  });

  it("drops non-http image schemes", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:image/svg+xml,<svg/>",
      "file:///etc/passwd",
      "",
      null,
    ]) {
      assert.equal(imageUrl(bad), null, String(bad));
    }
  });

  it("keeps http article links intact but blocks scripts", () => {
    assert.equal(externalUrl("http://news.example.com/a"), "http://news.example.com/a");
    assert.equal(externalUrl("javascript:alert(1)"), null);
  });
});

describe("clip", () => {
  it("leaves short text alone and ellipsises long text", () => {
    assert.equal(clip("short"), "short");
    assert.equal(clip(null), null);
    const long = clip("x".repeat(500))!;
    assert.equal(long.length, 201);
    assert.ok(long.endsWith("…"));
  });
});

describe("normalizeArticles", () => {
  it("filters blocked sources, upgrades images and fills gaps", () => {
    const [a, b] = normalizeArticles([
      { source_id: "reflector", title: "spam" },
      {
        article_id: "abc",
        title: "Headline",
        description: null,
        link: "https://example.com/a",
        image_url: "http://cdn.example.com/a.jpg",
        source_name: "Example",
        category: ["tech"],
        country: ["uk"],
        pubDate: "2026-08-15 00:46:00",
      },
      { link: "javascript:alert(1)" },
    ]);

    assert.equal(a!.id, "abc");
    assert.equal(a!.image, "https://cdn.example.com/a.jpg");
    assert.equal(a!.category, "tech");
    assert.equal(b!.link, "#");
    assert.equal(b!.title, "Untitled transmission");
    assert.equal(b!.country, "global");
  });
});

describe("upstream budget", () => {
  it("stops at the cap and resets on the next UTC day", () => {
    const day1 = Date.parse("2026-08-15T23:59:00Z");
    const day2 = Date.parse("2026-08-16T00:01:00Z");
    const budget = createBudget(2);

    assert.equal(budget.available(day1), true);
    budget.spend();
    budget.spend();
    assert.equal(budget.available(day1), false);
    assert.equal(budget.available(day2), true);
    assert.equal(budget.used, 0);
  });
});

describe("feed cache", () => {
  it("serves fresh entries and expires stale ones", () => {
    const cache = createCache();
    const t0 = 1_000_000;
    cache.set("all:1", feed(), t0);

    assert.ok(cache.get("all:1", t0 + 60_000));
    assert.equal(cache.get("all:1", t0 + 31 * 60_000), undefined);
    assert.ok(cache.stale("all:1"), "stale copy stays available for quota fallback");
  });

  it("expires error entries far sooner than good ones", () => {
    const cache = createCache();
    cache.set("all:1", feed("UPSTREAM"), 0);
    assert.ok(cache.get("all:1", 30_000));
    assert.equal(cache.get("all:1", 61_000), undefined);
  });

  it("evicts the least recently written entry, not a hot one", () => {
    const cache = createCache(2);
    cache.set("a", feed(), 0);
    cache.set("b", feed(), 0);
    cache.set("a", feed(), 1);
    cache.set("c", feed(), 2);

    assert.equal(cache.size, 2);
    assert.ok(cache.stale("a"), "a was rewritten so it must outlive b");
    assert.equal(cache.stale("b"), undefined);
    assert.ok(cache.stale("c"));
  });
});

describe("rate limiter", () => {
  it("blocks a client past its per-window ceiling", () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < RATE_MAX_PER_CLIENT; i++) {
      assert.equal(limiter.over("1.2.3.4", 0), false, `request ${i}`);
    }
    assert.equal(limiter.over("1.2.3.4", 0), true);
  });

  it("gives the shared bucket a higher ceiling and forgets it after the window", () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < RATE_MAX_SHARED; i++) limiter.over(SHARED_KEY, 0);
    assert.equal(limiter.over(SHARED_KEY, 0), true);
    assert.equal(limiter.over(SHARED_KEY, 61_000), false);
  });

  it("bounds its map without wiping every other client's counter", () => {
    const limiter = createRateLimiter(3);
    for (let i = 0; i < 50; i++) limiter.over(`ip-${i}`, 0);
    assert.equal(limiter.size, 3);

    for (let i = 0; i < RATE_MAX_PER_CLIENT; i++) limiter.over("victim", 0);
    limiter.over("noise", 0);
    assert.equal(
      limiter.over("victim", 0),
      true,
      "an attacker's churn must not reset a tracked client",
    );
  });
});

describe("clientKey", () => {
  const req = (headers: Record<string, string>) => new Request("https://x.test", { headers });

  it("trusts CF-Connecting-IP by default on the Cloudflare target", () => {
    assert.equal(clientKey(req({ "cf-connecting-ip": "9.9.9.9" }), {}), "9.9.9.9");
  });

  it("can be opted out when the app is not behind Cloudflare", () => {
    assert.equal(
      clientKey(req({ "cf-connecting-ip": "9.9.9.9" }), { TRUST_CF_IP: "0" }),
      SHARED_KEY,
    );
  });

  it("ignores forwarding headers unless explicitly trusted", () => {
    assert.equal(clientKey(req({ "x-forwarded-for": "9.9.9.9" }), {}), SHARED_KEY);
    assert.equal(
      clientKey(req({ "x-forwarded-for": "9.9.9.9" }), { TRUST_PROXY_HEADERS: "1" }),
      "9.9.9.9",
    );
  });

  it("takes the entry the proxy appended, not the one the caller sent", () => {
    assert.equal(
      clientKey(req({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" }), { TRUST_PROXY_HEADERS: "1" }),
      "9.9.9.9",
    );
  });

  it("cannot be tricked into a fresh bucket by padding the chain", () => {
    const spoofed = ["evil-1", "evil-2", "evil-3"].map((pad) =>
      clientKey(req({ "x-forwarded-for": `${pad}, 9.9.9.9` }), { TRUST_PROXY_HEADERS: "1" }),
    );
    assert.deepEqual(spoofed, ["9.9.9.9", "9.9.9.9", "9.9.9.9"]);
  });

  it("falls back to x-real-ip only when the chain is absent", () => {
    assert.equal(
      clientKey(req({ "x-real-ip": "9.9.9.9" }), { TRUST_PROXY_HEADERS: "1" }),
      "9.9.9.9",
    );
    assert.equal(clientKey(req({ "x-real-ip": "9.9.9.9" }), {}), SHARED_KEY);
  });
});
