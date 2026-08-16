import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CATEGORIES, REFRESH_INTERVAL, getWorldNews, type NewsArticle } from "@/lib/news.functions";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "SARENIT FEED — Live World News Terminal" },
      {
        name: "description",
        content:
          "A sci-fi news terminal streaming the newest world headlines by category, source and region in real time.",
      },
      {
        property: "og:title",
        content: "SARENIT FEED — Live World News Terminal",
      },
      {
        property: "og:description",
        content: "Live global headlines rendered as a futuristic mission-control terminal.",
      },
    ],
  }),
  component: NewsTerminal,
});

const ZONES = [
  { label: "LDN", tz: "Europe/London" },
  { label: "BER", tz: "Europe/Berlin" },
  { label: "BRU", tz: "Europe/Brussels" },
  { label: "DC", tz: "America/New_York" },
  { label: "OTT", tz: "America/Toronto" },
  { label: "MEX", tz: "America/Mexico_City" },
].map((z) => ({
  ...z,
  fmt: new Intl.DateTimeFormat("en-GB", {
    timeZone: z.tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }),
}));

function Clocks() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <div className="text-right">
        <div className="text-primary/70">UTC_TIME</div>
        <div className="text-lg font-bold tabular-nums">
          {now ? now.toISOString().slice(11, 19) : "--:--:--"}
        </div>
      </div>

      <div className="hidden grid-cols-3 gap-x-4 gap-y-0.5 border-l border-primary/20 pl-4 text-[10px] lg:grid">
        {ZONES.map((z) => (
          <div key={z.label} className="flex items-baseline justify-between gap-2">
            <span className="text-primary/70">{z.label}</span>
            <span className="font-bold tabular-nums">{now ? z.fmt.format(now) : "--:--"}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function NewsTerminal() {
  const [category, setCategory] = useState<string>("all");
  const fetchNews = useServerFn(getWorldNews);

  const { data, isFetching, isFetchingNextPage, isError, hasNextPage, fetchNextPage, refetch } =
    useInfiniteQuery({
      queryKey: ["news", category],
      queryFn: ({ pageParam }) => fetchNews({ data: { category, page: pageParam } }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last, _pages, lastParam) =>
        last.nextPage && last.nextPage !== lastParam ? last.nextPage : undefined,
      refetchInterval: REFRESH_INTERVAL,
      retry: (failureCount, error) => {
        const status =
          error instanceof Response ? error.status : (error as { status?: number } | null)?.status;
        return status === 429 ? false : failureCount < 1;
      },
    });

  const seen = new Set<string>();
  const articles = (data?.pages.flatMap((p) => p.articles) ?? []).filter((a: NewsArticle) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
  const feedError = data?.pages.find((p) => p.error)?.error ?? (isError ? "TRANSPORT" : null);
  const [lead, ...rest] = articles;

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && fetchNextPage(), {
      rootMargin: "600px",
    });
    io.observe(node);
    return () => io.disconnect();
  }, [hasNextPage, fetchNextPage]);

  return (
    <main className="flex min-h-screen w-full items-start justify-center bg-background p-4 text-primary md:p-8">
      <div className="scanlines relative w-full max-w-[1800px] overflow-hidden border border-border bg-background shadow-[var(--glow-primary)]">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-primary/30 bg-card p-4 md:flex md:flex-wrap md:justify-between">
          <div className="flex min-w-0 items-center gap-6">
            <h1 className="truncate font-display text-3xl tracking-tighter text-primary text-glow md:text-4xl">
              SARENIT//FEED
            </h1>
            <div className="hidden items-center gap-2 border border-primary/40 bg-primary/5 px-3 py-1 text-[10px] font-bold tracking-[0.2em] sm:flex">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              {isFetching ? "SYNCING" : "SYSTEM.LIVE"}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-4 font-mono text-xs md:gap-8">
            <div className="hidden text-right sm:block">
              <div className="text-primary/70">SYNC_NODE</div>
              <div className="text-primary">RELAY_NEWSDATA</div>
            </div>
            <Clocks />
            <button
              onClick={() => refetch()}
              className="cursor-crosshair border border-transparent bg-primary px-4 py-2 font-bold uppercase tracking-widest text-primary-foreground transition-colors hover:bg-foreground active:scale-95"
            >
              RE-SCAN
            </button>
            <ThemeSwitcher />
          </div>
        </header>

        <div className="overflow-hidden whitespace-nowrap border-b border-primary/20 bg-primary/5 py-1.5">
          <div
            role="marquee"
            tabIndex={0}
            aria-label="Latest headlines ticker — focus to pause"
            className="inline-block animate-ticker text-[10px] font-bold uppercase tracking-[0.3em] text-primary/80"
          >
            {articles.length === 0
              ? ">> AWAITING UPLINK AUTHORISATION // GLOBAL RELAY STANDING BY >>"
              : `>> ${articles
                  .slice(0, 12)
                  .map((a) => `${a.source.toUpperCase()}: ${a.title}`)
                  .join(" // ")} >>`}
          </div>
        </div>

        <nav className="flex flex-wrap gap-2 border-b border-primary/10 bg-background p-4">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={`border px-4 py-1 text-xs font-bold uppercase tracking-tighter transition-colors ${
                category === c
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-primary/30 text-primary/70 hover:bg-primary/10"
              }`}
            >
              {c === "all" ? "ALL_NET" : `${c}_`}
            </button>
          ))}
          <span className="ml-auto hidden border border-accent/50 px-4 py-1 text-xs font-bold italic uppercase tracking-tighter text-accent sm:block">
            !!LIVE_OPS!!
          </span>
        </nav>

        {feedError === "NO_KEY" && (
          <section className="m-4 border border-accent/40 bg-card p-6">
            <h2 className="font-display text-2xl tracking-wide text-accent">UPLINK KEY REQUIRED</h2>
            <p className="mt-2 max-w-2xl text-sm text-primary/70">
              Terminal online, no credentials for the global news relay. Add a newsdata.io API key
              to start streaming live headlines.
            </p>
          </section>
        )}

        {feedError === "QUOTA" && (
          <section className="m-4 border border-accent/40 bg-card p-6">
            <h2 className="font-display text-2xl tracking-wide text-accent">RELAY RATIONED</h2>
            <p className="mt-2 max-w-2xl text-sm text-primary/70">
              Daily uplink allowance spent. Feed resumes at 00:00 UTC.
            </p>
          </section>
        )}

        {feedError && feedError !== "NO_KEY" && feedError !== "QUOTA" && (
          <section className="m-4 border border-destructive/50 bg-card p-6">
            <h2 className="font-display text-2xl tracking-wide text-destructive">RELAY ERROR</h2>
            <p className="mt-2 font-mono text-sm text-primary/75">{feedError}</p>
          </section>
        )}

        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-4">
          {isFetching &&
            articles.length === 0 &&
            !feedError &&
            Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className={`h-40 animate-pulse border border-primary/20 bg-card ${i === 0 ? "md:col-span-3 md:row-span-2 md:h-auto md:min-h-80" : ""}`}
              />
            ))}

          {lead && (
            <article className="group relative overflow-hidden border border-accent/40 bg-card md:col-span-3 md:row-span-2">
              <div className="absolute right-0 top-0 z-20 bg-accent px-3 py-1 font-display text-sm tracking-widest text-accent-foreground">
                PRIORITY SIGNAL
              </div>
              <div className="relative aspect-[16/9] w-full">
                {lead.image ? (
                  <img
                    src={lead.image}
                    alt={lead.title}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(e) => e.currentTarget.classList.add("hidden")}
                    className="size-full object-cover opacity-60 grayscale transition-all duration-1000 group-hover:opacity-100 group-hover:grayscale-0"
                  />
                ) : (
                  <div className="flex size-full items-center justify-center bg-background font-mono text-xs text-primary/70">
                    NO VISUAL FEED
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-card via-card/40 to-transparent" />
                <div className="pointer-events-none absolute inset-4 border border-primary/10" />
                <div className="absolute left-6 top-6 font-mono text-[10px] text-primary/70">
                  FRAME_ID: {lead.id.slice(0, 8).toUpperCase()}
                </div>

                <div className="absolute bottom-0 w-full p-6">
                  <div className="mb-2 flex flex-wrap items-center gap-4">
                    <span className="text-xs font-bold text-accent">
                      SOURCE: {lead.source.toUpperCase()}
                    </span>
                    <span className="font-mono text-xs text-primary/75">
                      CH: {lead.category.toUpperCase()}
                    </span>
                  </div>
                  <h2 className="mb-4 font-display text-3xl uppercase leading-none text-foreground transition-colors group-hover:text-accent md:text-5xl">
                    {lead.title}
                  </h2>
                  {lead.description && (
                    <p className="mb-6 max-w-2xl border-l-2 border-accent pl-4 text-sm italic leading-relaxed text-primary/80">
                      {lead.description}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-4 font-mono text-[10px] text-primary/70">
                      <span>GEO: {lead.country.toUpperCase()}</span>
                      {lead.publishedAt && <span>TIME: {lead.publishedAt.slice(0, 16)}</span>}
                    </div>
                    <a
                      href={lead.link}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-bold uppercase text-accent transition-all hover:tracking-[0.3em]"
                    >
                      DECRYPT_FULL_INTEL &gt;
                    </a>
                  </div>
                </div>
              </div>
            </article>
          )}

          {rest.map((a, i) => {
            const alert = i % 5 === 4;
            const wide = i % 5 === 2 || i % 5 === 3;
            if (a.image && i % 5 === 1) {
              return (
                <article
                  key={a.id}
                  className="group overflow-hidden border border-primary/20 bg-card"
                >
                  <div className="h-32">
                    <img
                      src={a.image}
                      alt={a.title}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={(e) => e.currentTarget.classList.add("hidden")}
                      className="size-full object-cover opacity-50 grayscale transition-all group-hover:scale-105 group-hover:opacity-100 group-hover:grayscale-0"
                    />
                  </div>
                  <div className="p-4">
                    <h3 className="mb-1 font-display text-xl uppercase leading-tight">{a.title}</h3>
                    {a.description && (
                      <p className="mb-3 line-clamp-2 text-xs text-primary/70">{a.description}</p>
                    )}
                    <a
                      href={a.link}
                      target="_blank"
                      rel="noreferrer"
                      className="border border-primary/30 px-2 py-0.5 font-mono text-[9px] uppercase text-primary/75 hover:text-accent"
                    >
                      {a.source}
                    </a>
                  </div>
                </article>
              );
            }

            if (alert) {
              return (
                <article
                  key={a.id}
                  className="group relative border border-accent/40 bg-card p-4 hover:bg-accent/5 md:col-span-2"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="block size-2 animate-pulse bg-accent" />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-accent">
                          {a.category}_ALERT
                        </span>
                      </div>
                      <h3 className="mb-2 font-display text-2xl uppercase leading-none text-accent">
                        <a href={a.link} target="_blank" rel="noreferrer">
                          {a.title}
                        </a>
                      </h3>
                      {a.description && (
                        <p className="line-clamp-2 text-xs text-accent/70">{a.description}</p>
                      )}
                    </div>
                    <div className="shrink-0 text-right font-mono text-[9px] uppercase text-accent/70">
                      {a.source}
                      <br />
                      {a.publishedAt?.slice(11, 16) ?? "--:--"}
                    </div>
                  </div>
                </article>
              );
            }

            if (wide) {
              return (
                <article
                  key={a.id}
                  className="group flex items-center gap-4 border border-primary/20 bg-card p-4 hover:bg-primary/5 md:col-span-2"
                >
                  {a.image && (
                    <img
                      src={a.image}
                      alt={a.title}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={(e) => e.currentTarget.classList.add("hidden")}
                      className="size-20 shrink-0 object-cover opacity-40 grayscale transition-all group-hover:opacity-100 group-hover:grayscale-0"
                    />
                  )}
                  <div className="min-w-0 grow">
                    <div className="mb-2 h-1 w-8 bg-primary/40" />
                    <h3 className="mb-1 font-display text-2xl uppercase leading-tight">
                      <a href={a.link} target="_blank" rel="noreferrer">
                        {a.title}
                      </a>
                    </h3>
                    <div className="font-mono text-[10px] uppercase text-primary/70">
                      {a.source} // {a.country} // {a.publishedAt?.slice(0, 16) ?? "UNKNOWN"}
                    </div>
                  </div>
                </article>
              );
            }

            return (
              <article
                key={a.id}
                className="flex flex-col justify-between border border-primary/20 bg-card p-4 hover:bg-primary/5"
              >
                <div>
                  <div className="mb-2 font-mono text-[10px] uppercase text-primary/75">
                    {a.category}_WATCH
                  </div>
                  <h3 className="mb-2 font-display text-xl uppercase leading-tight">
                    <a href={a.link} target="_blank" rel="noreferrer">
                      {a.title}
                    </a>
                  </h3>
                  {a.description && (
                    <p className="line-clamp-3 text-xs leading-snug text-primary/70">
                      {a.description}
                    </p>
                  )}
                </div>
                <div className="mt-4 flex justify-between border-t border-primary/10 pt-4 font-mono text-[9px] uppercase">
                  <span className="text-primary/70">{a.source}</span>
                  <span className="text-primary/80">{a.publishedAt?.slice(5, 16) ?? "--"}</span>
                </div>
              </article>
            );
          })}
        </div>

        {articles.length > 0 && (
          <div
            ref={sentinel}
            className="border-t border-primary/10 p-6 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-primary/70"
          >
            {isFetchingNextPage
              ? "PULLING NEXT PACKET…"
              : hasNextPage
                ? "SCROLL FOR MORE SIGNAL"
                : "END OF TRANSMISSION"}
          </div>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-primary/20 bg-card p-4 font-mono text-[9px]">
          <div className="flex items-center gap-4">
            <span className="text-primary/75">TRANSPORT: TLS 1.3</span>
            <span className="border border-primary/20 bg-primary/5 px-2 py-0.5 text-primary/80">
              NODE: {isFetching ? "SYNCING" : "STABLE"}
            </span>
          </div>
          <div className="flex gap-6">
            <span className="text-primary/75">RELAY: NEWSDATA.IO</span>
            <span className="text-primary/75">AUTO_RESCAN: {REFRESH_INTERVAL / 60_000}M</span>
            <span className="text-primary">SIGNALS: {articles.length}</span>
          </div>
        </footer>
      </div>
    </main>
  );
}
