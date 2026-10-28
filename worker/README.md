# Website Health & Security Checker: backend

This folder is the server side of [/tools/website-health-checker/](https://sanaullahniazi.com/tools/website-health-checker/).
GitHub Pages can't run code, so the checks run on a free **Cloudflare Worker** at `https://api.sanaullahniazi.com`,
with reports in a free **Cloudflare D1** database. A GitHub Action (`.github/workflows/deploy-worker.yml`) deploys it.

Everything here fits the free plans. Nothing costs money unless traffic grows past them (Workers Paid is $5 a month).

| Service | Used for | Free limit |
|---|---|---|
| Cloudflare Workers | runs the checks | 100,000 requests a day, 50 outside requests per call |
| Cloudflare D1 | stores reports for 7 days, rate-limit counters | 5 GB, 100,000 writes a day |
| Cloudflare Turnstile | the "I'm human" check | free |
| Google PageSpeed Insights | Lighthouse on mobile and desktop, screenshots | 25,000 runs a day |
| Mozilla HTTP Observatory | headers grade | free, no key |
| Qualys SSL Labs | TLS grade and certificate | free, registered email, non-commercial use |
| Cloudflare DNS over HTTPS | SPF, DMARC, DKIM and the private-address check | free, no key |

The checker's own limits are in `wrangler.toml`: 5 scans per visitor per hour, 300 fresh scans a day in total,
results reused for 1 hour, reports deleted after 7 days.

## Prompt injection lab

The same Worker runs the live bot of [/tools/prompt-injection-lab/](https://sanaullahniazi.com/tools/prompt-injection-lab/)
(`src/lab.js`, routes `POST /lab/session` and `POST /lab/run`). The model runs on **Cloudflare Workers AI** through the
`[ai]` binding in `wrangler.toml`: no API key, and the free plan's 10,000 "neurons" a day cover roughly 900 attacks.
The lab reuses the Turnstile widget and the `hits` table; it stores no attack text or replies.
Its input filter is `../_data/pil_rules.json` (shared with the page) and the tests read `../_data/pil_attacks.yml`.

If a deploy fails with a permissions error about Workers AI, add **Account · Workers AI · Read** to the deploy token (My Profile → API Tokens → edit).
To turn the live bot off, remove the `[ai]` lines from `wrangler.toml`: the page then offers only the filter and
"Test your own chatbot".

## One-time setup

### 1. Turnstile (the CAPTCHA)

1. In the Cloudflare dashboard, open **Turnstile** and click **Add widget**.
2. Name it `Website checker`, add the hostnames `sanaullahniazi.com` and `www.sanaullahniazi.com`, and keep **Managed** mode.
3. Copy the **Site key** (public) and the **Secret key** (private).

### 2. Google PageSpeed Insights API key

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) with the Google account you used for Gemini, and pick or create a project.
2. **APIs & Services → Library**, search **PageSpeed Insights API**, click **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key**. Copy it.
4. Click the new key, under **API restrictions** choose **Restrict key → PageSpeed Insights API**, and save.
   Leave "Application restrictions" on None, because the key is used by the server, not a browser.

### 3. SSL Labs (already done)

`sana@sanaullahniazi.com` is registered. To use another address, register it once:

```
curl -X POST https://api.ssllabs.com/api/v4/register -H "Content-Type: application/json" \
  -d '{"firstName":"Sana Ullah","lastName":"Khan","email":"you@yourdomain.com","organization":"yourdomain.com"}'
```

### 4. Cloudflare API token and account ID (so GitHub can deploy)

1. Cloudflare dashboard → your profile icon → **My Profile → API Tokens → Create Token**.
2. Use the **Edit Cloudflare Workers** template. Click **+ Add more** and add **Account · D1 · Edit**.
3. Under **Account Resources** pick your account, under **Zone Resources** pick `sanaullahniazi.com`. Create it and copy the token.
4. Your **Account ID** is on the right side of the **Workers & Pages** overview page (or in the dashboard address: `dash.cloudflare.com/<account id>/...`).

### 5. Add the secrets to GitHub

In the repository: **Settings → Secrets and variables → Actions → New repository secret**. Add:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 4 |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID from step 4 |
| `PSI_KEY` | the PageSpeed key from step 2 |
| `TURNSTILE_SECRET` | the Turnstile **secret** key from step 1 |
| `SSL_LABS_EMAIL` | `sana@sanaullahniazi.com` (leave it out to turn SSL Labs off) |
| `HASH_SALT` | optional: any long random text, used to hash IP addresses for the rate limit |

### 6. Deploy and switch the page on

1. **Actions → Deploy website checker → Run workflow**. It creates the database, deploys the Worker at
   `api.sanaullahniazi.com` and uploads the secrets. It also runs by itself whenever `worker/` changes on `main`.
2. Open `https://api.sanaullahniazi.com/`. It should show `{"ok":true,"ssl":true,"psi":true}`.
3. In `_config.yml`, paste the Turnstile **site** key into `health_checker.turnstile_sitekey`. The tool page stays
   in "being set up" mode until it's filled in.

## How it works

- `src/index.js`: the API. `POST /scan` checks the CAPTCHA, the rate limit and the address, then returns a scan id.
  The page then calls `POST /scan/<id>/<part>` for each part (`core`, `psi-mobile`, `psi-desktop`, `links-0`,
  `links-1`, `ssl`) in parallel, because a free Worker may make only 50 outside requests per call.
  `GET /report/<id>` returns the report, which is also what a shared link shows.
- `src/net.js`: resolves every host with DNS over HTTPS and refuses private, internal and reserved addresses
  (also after each redirect), odd ports and non-web schemes.
- `src/core.js`: the page, headers, cookies, robots.txt, sitemap, security.txt, SPF/DMARC/DKIM, Observatory,
  technology and outdated libraries. `src/psi.js`, `src/links.js`, `src/ssl.js`: the other parts.
- `src/report.js`: turns results into issues with a severity, category scores, the overall score and grade.
  The page turns each issue code into text in the visitor's language (`web_*`, `w_*` and `wi_*` in `_data/*/tools.yml`).
- `src/vulndb.json`: known-vulnerable JavaScript library versions from [Retire.js](https://github.com/RetireJS/retire.js)
  (Apache-2.0). Refresh it with `npm run vulndb`.

## Local development

```
cd worker
npm install
npm test                                                # unit tests, no Cloudflare needed
npx wrangler d1 execute site-checker --local --file=schema.sql
echo "TURNSTILE_SECRET=1x0000000000000000000000000000000AA" > .dev.vars   # Cloudflare's always-pass test key
npx wrangler dev
```

For the page, set `health_checker.api` to `http://localhost:8787` and `turnstile_sitekey` to Cloudflare's test site key
`1x00000000000000000000AA` in a local config file, and run Jekyll with `--config _config.yml,_local.yml`.
