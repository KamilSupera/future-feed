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

| Command             | What it does                                                       |
| ------------------- | ------------------------------------------------------------------ |
| `bun run dev`       | Dev server on :8080                                                |
| `bun run typecheck` | `tsc --noEmit`                                                     |
| `bun run lint`      | ESLint + Prettier                                                  |
| `bun run test`      | Unit tests via the Node test runner (no test framework dependency) |
| `bun run build`     | Production build for the Cloudflare Workers target                 |

Dependencies are upgraded by hand with `bun update`, not by a bot. Dependabot watches the GitHub Actions used in the workflows, but not npm: it does not maintain `bun.lock`, so every npm PR it opened changed `package.json` alone and failed `bun install --frozen-lockfile` before a single check could run. What actually matters — a dependency turning out to be vulnerable — is caught by `bun audit --audit-level=high` in CI, which fails the build.

One upgrade is pinned deliberately: `typescript` stays on 6.x because no published `typescript-eslint` supports TypeScript 7 yet, and ESLint refuses to start against it. Revisit once upstream ships support.

Tests need Node 24 or newer, which runs TypeScript directly. They cover the parts that are easy to get quietly wrong: page-token signing, URL scheme handling, the daily upstream budget, cache expiry and eviction, and the rate limiter.

## Environment

The feed needs a [newsdata.io](https://newsdata.io) API key. Put it in `.env` (gitignored, never commit it):

```sh
echo 'NEWSDATA_API_KEY=your_key_here' > .env
chmod 600 .env
```

In production, set `NEWSDATA_API_KEY` in your host's dashboard instead of shipping the file.

| Variable              | Default                          | Purpose                                                                                                                                                                                  |
| --------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEWSDATA_API_KEY`    | —                                | Required. Upstream credential, server-side only.                                                                                                                                         |
| `PAGE_TOKEN_SECRET`   | falls back to `NEWSDATA_API_KEY` | HMAC key for pagination tokens. Set it to something separate so rotating the API key does not also invalidate every outstanding page token.                                              |
| `TRUST_CF_IP`         | on                               | Rate-limit callers by `CF-Connecting-IP`. Correct on the Cloudflare Workers target, where the header cannot be reached around. Set `TRUST_CF_IP=0` if you serve this from anywhere else. |
| `TRUST_PROXY_HEADERS` | off                              | Set to `1` only when a reverse proxy you control rewrites `X-Forwarded-For`. Anyone who can reach the origin directly can forge it.                                                      |

With CF trust disabled and no proxy trust, every caller shares one bucket with a higher ceiling, so one noisy client can exhaust it for everyone.

## Upstream budget

newsdata.io's free tier allows 200 credits/day and delays articles by 12 hours. Three things keep usage under that:

1. An in-memory response cache, 30 minutes for good responses and 60 seconds for errors.
2. `cf.cacheTtl` on the upstream fetch, so Cloudflare's edge serves repeat calls without them reaching newsdata at all. A response served from that cache does not spend budget.
3. A counter that stops outbound calls at 150/day and falls back to the last stale response.

**Know the limit of that guarantee.** The cache and the counter live in Workers isolate memory, and no KV or Durable Object is bound. The 150/day cap therefore applies per isolate, not globally, and the edge cache is per colo — so worldwide traffic across many colos can still exceed the free tier. If that matters for your deployment, bind a KV namespace and move the counter into it. The limits live in `src/lib/news.core.ts`, `src/lib/news.functions.ts` and `src/lib/rate-limit.ts`.

## Deploying to AWS

`scripts/deploy-aws.sh` puts the app on Lambda behind CloudFront. It is idempotent — the first run creates everything, later runs only ship new code.

```sh
AWS_PROFILE=sarenit-main ./scripts/deploy-aws.sh
```

The script takes credentials from the usual AWS CLI resolution, so `AWS_PROFILE` picks the account and its region. Point it at an IAM user, never at root: root credentials cannot be scoped down or revoked separately from the account itself. `REGION` and `FUNCTION` override the defaults if you need a second environment.

It builds with `NITRO_PRESET=aws-lambda`, zips `.output`, then creates (or reuses) an IAM role, an arm64 Lambda on `nodejs22.x`, a function URL, an Origin Access Control and a CloudFront distribution. `NEWSDATA_API_KEY` is read from the environment or `.env` and set as a Lambda environment variable. Log retention is capped at 7 days.

The function URL stays on `AWS_IAM` and is never public: CloudFront signs every origin request with SigV4 through OAC, so the distribution is the only way in. Two Lambda permissions are required for this to work — `lambda:InvokeFunctionUrl` to reach the URL and `lambda:InvokeFunction` to run the function behind it. With only the first, every request returns 403.

CloudFront serves `/assets/*` from cache with a one-year immutable TTL, so the hashed bundles and fonts stop reaching Lambda after the first request. HTML and server-function calls are not cached.

Everything sits inside perpetual free tiers: Lambda's 1M requests and 400k GB-seconds per month, CloudFront's 1 TB egress and 10M requests per month, and 7-day CloudWatch log retention. `PriceClass_100` keeps edge locations to North America and Europe.

**Caveat specific to Lambda.** The `cf.cacheTtl` edge caching described above only exists on Cloudflare. On Lambda the feed cache and the daily counter live in a warm execution container, so a cold start begins with an empty cache and spends one upstream call. Sporadic traffic therefore costs more newsdata credits than steady traffic. The 150/day cap still protects the quota, but if this ever needs a real shared cache, DynamoDB or ElastiCache is the next step.

To build for Cloudflare instead, leave `NITRO_PRESET` unset — `cloudflare-module` is still the default.

### Deploying from CI

`.github/workflows/deploy.yml` runs the same script on every push to `develop`, and on demand via _Actions → Deploy → Run workflow_. It authenticates with GitHub OIDC, so this repository holds no AWS keys — only a `AWS_DEPLOY_ROLE` variable naming the role to assume. The role can touch the `future-feed` function, its CloudFront distribution and its log group, and can pass exactly one execution role; it cannot create IAM roles, which keeps a compromised workflow from escalating.

The workflow never receives `NEWSDATA_API_KEY`. The key is set once on the function — by the first local deploy, or by hand in the console — and CI leaves it in place. A first-time deploy into an empty account has to run locally, since only that path creates the Lambda execution role.

After shipping, the job polls the CloudFront URL until it answers 200 and fails the run if it never does.

## Security posture

- The API key never reaches the browser. All upstream calls happen in a server function.
- Pagination tokens are HMAC-signed, so a caller cannot inject arbitrary values into the upstream query.
- Server functions run behind CSRF and rate-limit middleware.
- Responses carry a CSP, HSTS, `nosniff`, `frame-ancestors 'none'`, a restrictive `Permissions-Policy` and COOP/CORP.
- Article images are forced to `https` and requested with `referrerpolicy="no-referrer"`, so publishers' image hosts never see where the request came from.

The CSP still allows `'unsafe-inline'` for scripts and styles, because SSR hydration data and inline style props need it. Tightening that means threading a nonce through `<Scripts>`.

## Attribution and content

Headlines, 200-character description snippets, and article links come from newsdata.io; every article links back to the publisher. Review newsdata.io's terms for your own use before deploying publicly — in particular their rules on redistribution, caching duration and required attribution.

Article images are hotlinked from publisher servers rather than copied or cached. If you deploy this beyond personal use, that is the piece most worth replacing with a licensed or proxied source.

The app stores one thing on the visitor's device: the selected palette, under `sarenit-theme` in `localStorage`. There is no analytics, no cookie, no account and no server-side visitor logging. A public deployment in the EU will still want a privacy notice and an imprint.

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS
- Nitro (Cloudflare)
