# Website health and security checker

A free website scanner: enter an address and get a score, a grade and plain-English fixes for security
headers, SSL/TLS, cookies, email security (SPF, DMARC, DKIM), speed and Core Web Vitals, SEO,
accessibility, mobile design and outdated JavaScript libraries. Reports can be shared by link and
downloaded as a PDF.

**Try it live:** [sanaullahniazi.com/tools/website-health-checker](https://sanaullahniazi.com/tools/website-health-checker/)

![Website health and security checker](screenshots/website-health-checker.jpg)

## How it works

The page runs on GitHub Pages, which can't run server code, so the checks run on a **Cloudflare Worker**
(`worker/`) and reports are kept for 7 days in a **Cloudflare D1** database. Everything fits the free plans.

| Service | Used for |
|---|---|
| Cloudflare Workers and D1 | runs the checks, stores reports and rate-limit counters |
| Cloudflare Turnstile | the "I'm human" check |
| Google PageSpeed Insights | Lighthouse on mobile and desktop |
| Mozilla HTTP Observatory | security headers grade |
| Qualys SSL Labs | TLS grade and certificate |
| Cloudflare DNS over HTTPS | SPF, DMARC and DKIM, and blocking scans of private addresses |

The worker also matches the JavaScript libraries it finds against a list of known vulnerabilities
(`worker/src/vulndb.json`, refreshed by `worker/scripts/update-vulndb.mjs`).

## What's where

| Path | Contents |
|---|---|
| `worker/src/` | The Worker: `index.js` (API and rate limits), `core.js` (scoring), `net.js`, `ssl.js`, `tech.js`, `links.js`, `psi.js`, `report.js` |
| `worker/test/` | Tests (`npm test` in `worker/`) |
| `worker/schema.sql`, `worker/wrangler.toml` | Database tables and Worker settings |
| `worker/README.md` | Full setup guide: Turnstile, API keys, deploying |
| `assets/js/health-checker.js` | The page's front end |
| `assets/js/health-report-pdf.js` | The PDF report |
| `ci/deploy-worker.yml` | The GitHub Action that deploys the Worker (runs in the website repository) |

## Run your own

1. `cd worker && npm install`
2. Follow [worker/README.md](worker/README.md) to create the Turnstile widget, a PageSpeed Insights key and the D1 database.
3. Change `routes` and `ALLOWED_ORIGINS` in `wrangler.toml` to your own domain, then `npx wrangler deploy`.

## How this repository is kept up to date

This repository is an automatic mirror. The main copy lives in my website repository,
[Sanaullah-Niazi/portfolio](https://github.com/Sanaullah-Niazi/portfolio), and a GitHub Action copies these
files here every time the website changes. Please open an issue here for bugs or ideas: pull requests
can't be merged in this repository, because the next sync would overwrite them. I'll make the fix on the
website and it will show up here within minutes.

## License

[MIT](LICENSE) © Sana Ullah Khan. The website itself, its design and its other content are not covered by
this license.
