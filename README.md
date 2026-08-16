# SARENIT FEED

A world news reader dressed up as a mission control terminal. Headlines come from [newsdata.io](https://newsdata.io), and the page gives you category filters, infinite scroll, a row of capital city clocks and a palette switcher.

Live at <https://d3b9x4e1heyauk.cloudfront.net/>

Fetching headlines is the easy half. The half worth reading the code for is everything wrapped around a free API tier: keeping the upstream key out of the browser, signing the pagination tokens so nobody can steer the upstream query, rationing 200 credits a day, rate limiting without a database, and getting it onto AWS with no long-lived credential anywhere in the pipeline.

<img width="1493" height="3674" alt="SARENIT-FEED-—-Live-World-News-Terminal-08-16-2026_02_31_PM" src="https://github.com/user-attachments/assets/e87b5d72-a6d3-42b9-b689-d4622271f3ef" />

## Running it

You need [Bun](https://bun.sh). The lockfile is `bun.lock`, and `bunfig.toml` sets a 24 hour quarantine on freshly published packages that only Bun enforces. Installing with npm skips that guard silently and writes a second, conflicting lockfile.

```sh
bun install
cp .env.example .env
chmod 600 .env
bun run dev
```

Fill in `.env` before the first request: `NEWSDATA_API_KEY` from newsdata.io, and `PAGE_TOKEN_SECRET` from `openssl rand -hex 32`. Without a key the feed renders but returns `NO_KEY` instead of articles. The dev server listens on port 8080.

| Command             | What it does                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `bun run dev`       | Dev server on :8080                                                                                           |
| `bun run typecheck` | `tsc --noEmit`                                                                                                |
| `bun run lint`      | ESLint plus Prettier                                                                                          |
| `bun run test`      | Unit tests on the Node test runner, no test framework dependency                                              |
| `bun run build`     | Production build. `NITRO_PRESET=aws-lambda` targets the deployment below; unset builds for Cloudflare Workers |

Tests need Node 24 or newer, which runs TypeScript without a build step. They cover the things that break quietly: page token signing, URL scheme handling, the daily upstream budget, cache expiry and eviction, and the rate limiter.

## How it works

The browser never talks to newsdata.io. It calls a TanStack Start server function, `getWorldNews` in `src/lib/news.functions.ts`, and that function holds the API key, calls upstream and hands back a normalized feed. Three pieces sit between the request and the upstream call.

### Signed pagination

newsdata returns an opaque `nextPage` token that goes straight into the next upstream query. Handing that to the browser unsigned means the browser can hand back anything it likes. Instead the token is HMAC-SHA256'd, truncated to 16 hex characters and returned as `token~signature`. Anything that fails `^\d{1,32}~[0-9a-f]{16}$` or fails the constant time comparison gets `BAD_PAGE` and never reaches newsdata. The signing lives in `src/lib/news.core.ts`.

### Rationing the free tier

The free tier is 200 credits a day and articles arrive on a 12 hour delay. A counter stops outbound calls at 150 a day and serves the last stale response instead, and a response cache in front of it holds good responses for 30 minutes and errors for 60 seconds, capped at 200 entries with the oldest evicted first. On the Cloudflare target there is a third layer, `cf.cacheTtl` on the upstream fetch, which lets the edge answer repeats without touching newsdata at all. That hint does nothing anywhere else, so on Lambda every cache miss costs a credit.

Both the cache and the counter live in the server's own memory with no shared store behind them, so the 150 a day cap is per instance rather than global: per isolate and per colo on Cloudflare, per warm execution container on Lambda. Traffic spread across enough instances can still overrun the free tier. Moving the counter into a KV namespace or DynamoDB is the fix, and nothing in the code assumes it stays in memory.

### Rate limiting without a database

30 requests a minute per client, 300 for everyone sharing a bucket, tracked in a Map capped at 5000 keys with the oldest entries evicted first. The cap keeps a flood of one-off addresses from growing the map without bound, though it does mean a caller who can produce thousands of distinct keys can eventually push a tracked client out of it. Deciding who the client is turns out to be the harder problem, and it depends entirely on where you deployed.

## Configuration

| Variable              | Default                          | What it does                                                                                                                                                                  |
| --------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEWSDATA_API_KEY`    | none, required                   | Upstream credential. Server-side only, never sent to the browser.                                                                                                             |
| `PAGE_TOKEN_SECRET`   | falls back to `NEWSDATA_API_KEY` | HMAC key for pagination tokens. Set it. The fallback signs public tokens with the upstream credential, and rotating that credential then invalidates every outstanding token. |
| `TRUST_CF_IP`         | off                              | Set to `1` on Cloudflare Workers, where `CF-Connecting-IP` cannot be reached around. Leave it off anywhere else, because on any other host that header comes from the caller. |
| `TRUST_PROXY_HEADERS` | off                              | Set to `1` when a proxy you control is the only route to the origin. The limiter then keys on the last `X-Forwarded-For` entry, the one that proxy appended. Needed on AWS.   |

Both trust flags default to off. An IP header is worth something only if the caller cannot write it, so the default is to believe nobody and make each deployment opt in to the one header its own infrastructure actually guarantees.

When `TRUST_PROXY_HEADERS` is on, only the last entry in the chain counts. A caller can send an `X-Forwarded-For` of their own invention and the proxy appends to it, so everything ahead of the final entry is attacker supplied. Read the front of the chain and one client mints a fresh bucket per request and strolls past the limiter. That is safe on AWS because the Lambda function URL requires `AWS_IAM` and its policy admits only the CloudFront distribution, so nothing reaches the origin without passing through the proxy that appends. Do not set the flag where the origin is directly reachable.

With neither flag set every caller shares one bucket with a higher ceiling, so one noisy client can spend it for everyone.

## Deploying to AWS

`scripts/deploy-aws.sh` puts the app on Lambda behind CloudFront. It is idempotent: the first run creates everything, later runs only ship new code.

```sh
AWS_PROFILE=sarenit-main ./scripts/deploy-aws.sh
```

Credentials come from the usual AWS CLI resolution, so `AWS_PROFILE` picks the account and its region. Point it at an IAM user, never at root, because root credentials cannot be scoped down or revoked separately from the account itself. `REGION` and `FUNCTION` override the defaults if you want a second environment.

The script builds with `NITRO_PRESET=aws-lambda`, zips `.output`, then creates or reuses an IAM role, an arm64 Lambda on `nodejs22.x` with 512 MB and a 15 second timeout, a function URL, an Origin Access Control and a CloudFront distribution. `NEWSDATA_API_KEY` and `PAGE_TOKEN_SECRET` are read from the environment or `.env` and set as Lambda environment variables. Log retention is capped at 7 days.

The function URL stays on `AWS_IAM` and is never public. CloudFront signs every origin request with SigV4 through OAC, so the distribution is the only way in. That needs two Lambda permissions rather than the one you would expect: `lambda:InvokeFunctionUrl` to reach the URL and `lambda:InvokeFunction` to run the function behind it. With only the first, every request returns 403 and the error message tells you nothing.

CloudFront serves `/assets/*` from cache with a one year immutable TTL, so hashed bundles and fonts stop reaching Lambda after the first request. HTML and server function calls are not cached.

The whole thing sits inside perpetual free tiers: 1M Lambda requests and 400k GB-seconds a month, 1 TB of CloudFront egress and 10M requests a month, 7 day log retention. `PriceClass_100` keeps edge locations to North America and Europe.

One caveat specific to Lambda. Nothing caches upstream responses in front of the function, since the `cf.cacheTtl` hint above is Cloudflare only, and a cold start begins with an empty feed cache and spends a credit filling it. Sporadic traffic therefore costs more than steady traffic. The 150 a day cap still protects the quota, but a real shared cache is the next step if this ever needs one.

To build for Cloudflare instead, leave `NITRO_PRESET` unset, since `cloudflare-module` is still the default. Set `TRUST_CF_IP=1` there so the limiter keys on `CF-Connecting-IP`.

### Deploying from CI

Work lands on `develop` and reaches production by merging `develop` into `main`. `.github/workflows/deploy.yml` runs the same script on every push to `main`, and on demand through _Actions → Deploy → Run workflow_. It authenticates with GitHub OIDC, so this repository holds no AWS keys, only an `AWS_DEPLOY_ROLE` secret naming the role to assume. The role can touch the `future-feed` function, its CloudFront distribution and its log group, and can pass exactly one execution role. It cannot create IAM roles, which is what keeps a compromised workflow from escalating.

The workflow never receives `NEWSDATA_API_KEY` or `PAGE_TOKEN_SECRET`. Both are set once on the function, by the first local deploy or by hand in the console, and CI leaves them alone. A first deploy into an empty account has to run locally, because only that path creates the Lambda execution role.

After shipping, the job polls the CloudFront URL until it answers 200 and fails the run if it never does.

## Security posture

The API key never reaches the browser; every upstream call happens inside a server function. Pagination tokens are HMAC signed, so a caller cannot inject arbitrary values into the upstream query. Server functions run behind CSRF and rate limit middleware. Responses carry a CSP, HSTS, `nosniff`, `frame-ancestors 'none'`, a restrictive `Permissions-Policy` and COOP/CORP. Article images are forced to `https` and requested with `referrerpolicy="no-referrer"`, so publishers' image hosts never learn where the request came from.

The CSP still allows `'unsafe-inline'` for scripts and styles, because SSR hydration data and inline style props need it. Tightening that means threading a nonce through `<Scripts>`, which has not happened yet.

Found something? `SECURITY.md` has the reporting details. Please do not point a scanner at the live site, since the free tier gives out 200 requests a day and a scan takes the feed down for everyone.

## Content and attribution

Headlines, 200 character description snippets and article links come from newsdata.io, and every article links back to its publisher. Read newsdata.io's terms before you deploy this yourself, particularly the rules on redistribution, caching duration and required attribution.

Article images are hotlinked from publisher servers rather than copied or cached. If you take this past personal use, that is the first piece worth replacing with a licensed or proxied source.

The app stores exactly one thing on the visitor's device: the chosen palette, under `sarenit-theme` in `localStorage`. No analytics, no cookies, no accounts, no server side visitor logging. A public deployment in the EU will still want a privacy notice and an imprint.

## Built with

TanStack Start on Nitro, React and TypeScript, Tailwind for styling, Bun for installs and scripts. Dependencies are upgraded by hand with `bun update` rather than by a bot: Dependabot watches the GitHub Actions in the workflows but not npm, because it does not maintain `bun.lock`, so every npm PR it opened changed `package.json` alone and failed `bun install --frozen-lockfile` before a single check could run. The thing that actually needs catching, a dependency turning out to be vulnerable, is caught by `bun audit --audit-level=high` in CI, which fails the build.

One pin is deliberate. `typescript` stays on 6.x because no published `typescript-eslint` supports TypeScript 7 yet, and ESLint refuses to start against it. Worth revisiting once upstream ships support.

Licensed under Apache 2.0.
