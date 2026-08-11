# SARENIT FEED

A live world-news terminal. Headlines from [newsdata.io](https://newsdata.io) rendered as a sci-fi mission-control display, with category filters, infinite scroll, capital-city clocks and swappable palettes.

## Development

You need [Bun](https://bun.sh) — the lockfile is `bun.lock`, and `bunfig.toml` sets a 24h quarantine on freshly published packages that only Bun enforces. Installing with npm silently skips that guard and writes a second, conflicting lockfile.

```sh
git clone <this-repository-url>
cd <repository-name>
bun install
bun run dev
```

The dev server listens on port 8080.

## Environment

The feed needs a [newsdata.io](https://newsdata.io) API key. Put it in `.env` (gitignored, never commit it):

```sh
echo 'NEWSDATA_API_KEY=your_key_here' > .env
chmod 600 .env
```

In production, set `NEWSDATA_API_KEY` in your host's dashboard instead of shipping the file.

Two optional flags control how the server-function rate limiter identifies callers. Set exactly one, and only if it is true of your deployment — both headers are forgeable by anyone reaching the origin directly:

| Variable | Set it when |
| --- | --- |
| `TRUST_CF_IP=1` | Traffic reaches the app only through Cloudflare, which rewrites `CF-Connecting-IP`. |
| `TRUST_PROXY_HEADERS=1` | A reverse proxy you control rewrites `X-Forwarded-For`. |

With neither set, all callers share one bucket with a higher ceiling.

## Upstream budget

newsdata.io's free tier allows 200 credits/day and delays articles by 12 hours. The server function caches responses for 30 minutes, caps itself at 150 upstream calls per day, rate-limits per caller, and signs pagination tokens so they cannot be enumerated. Those limits live in `src/lib/news.functions.ts` and `src/start.ts`.

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS
- Nitro (Cloudflare)
