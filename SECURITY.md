# Security

This is a personal portfolio project, not a product with users or an on-call rotation. It is deployed publicly, though, so genuine findings are welcome and will be handled seriously.

## Reporting

Please report suspected vulnerabilities privately rather than opening a public issue. Use GitHub's [private vulnerability reporting](https://github.com/KamilSupera/future-feed/security/advisories/new) on this repository.

Include what you did, what happened, and what you expected. A proof of concept helps but is not required. Expect a first reply within a week; this is maintained in spare time.

Please do not run automated scanners, load tests, or anything that would spend the upstream news quota against the deployed site. The free tier allows 200 requests a day, so a scan takes the feed down for everyone.

## Scope

In scope: the application code in this repository, the server function that proxies newsdata.io, the response headers, and the AWS deployment described in `README.md`.

Out of scope: findings against newsdata.io itself, missing headers on third-party image hosts that articles link to, and reports whose only content is a scanner's output with no demonstrated impact.

## What is already known

- The Lambda holds the feed cache and daily upstream counter in memory, so both are per execution container rather than global. `README.md` explains the trade-off.
- The Content Security Policy allows `'unsafe-inline'` for scripts and styles, which server-rendered hydration data and inline style props currently require.
- Article images are hotlinked from publisher servers rather than proxied.

## Handling of credentials

No credential is stored in this repository. The upstream API key lives only as a Lambda environment variable. Deployments authenticate through GitHub OIDC against a role restricted to the `production` environment and the `develop` branch, so no long-lived AWS key exists in GitHub either.
