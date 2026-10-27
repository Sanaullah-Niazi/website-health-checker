// The core part of a scan: one fetch of the page plus the small files and DNS records around it.
// It only reads what any visitor's browser would get. Nothing is submitted, guessed or probed.
import { Budget, safeFetch, readText, txt, doh, baseDomain, UA } from "./net.js";
import { detectTech, libsFromUrls, libsFromContent, vulnsFor, compareVersions } from "./tech.js";

const DKIM_SELECTORS = ["google", "default", "selector1", "selector2", "k1", "s1", "mail", "dkim"];
const MAX_LINKS = 50;

export async function runCore(url) {
  const budget = new Budget(46);
  const cache = new Map();
  const out = { input: url };

  // 1. The page itself.
  const page = await safeFetch(budget, url, cache, { timeout: 15000 });
  const res = page.res;
  const final = new URL(page.url);
  out.finalUrl = page.url;
  out.status = res.status;
  out.ms = page.ms;
  out.redirects = page.chain.map((c) => ({ url: c.url, status: c.status }));
  out.https = final.protocol === "https:";
  out.headers = headerObject(res.headers);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of page.chain) setCookies.push(...(c.headers.getSetCookie ? c.headers.getSetCookie() : []));
  out.cookies = setCookies.slice(0, 30).map(parseCookie);

  const type = res.headers.get("content-type") || "";
  const html = /html|xml/i.test(type) || !type ? await readText(res, 2_000_000) : (res.body?.cancel(), "");
  out.bytes = html.length;
  out.isHtml = /<html|<head|<body/i.test(html.slice(0, 5000)) || /html/i.test(type);
  out.html = out.isHtml ? await parseHtml(html, final) : null;

  // 2. Does plain http:// send people to https://?
  const tasks = [];
  if (out.https) {
    tasks.push(
      (async () => {
        try {
          budget.take();
          const r = await fetch(`http://${final.host}/`, { redirect: "manual", headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
          r.body?.cancel();
          const loc = r.headers.get("location") || "";
          out.httpRedirect = r.status >= 300 && r.status < 400 ? (/^https:/i.test(new URL(loc, `http://${final.host}/`).href) ? "https" : "http") : "none";
        } catch { out.httpRedirect = "error"; }
      })(),
    );
  }

  // 3. robots.txt, then the sitemap it names (or /sitemap.xml).
  tasks.push(
    (async () => {
      out.robots = await smallFile(budget, cache, `${final.origin}/robots.txt`, (body) => {
        const sitemaps = [...body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]).slice(0, 5);
        return { sitemaps, disallowAll: robotsBlocksAll(body) };
      });
      const smUrl = out.robots?.sitemaps?.[0] || `${final.origin}/sitemap.xml`;
      out.sitemap = await smallFile(budget, cache, smUrl, (body) => ({
        valid: /<(urlset|sitemapindex)[\s>]/i.test(body),
        urls: (body.match(/<loc>/gi) || []).length,
      }));
      if (out.sitemap) out.sitemap.url = smUrl;
    })(),
  );

  // 4. security.txt (RFC 9116).
  tasks.push(
    (async () => {
      const parse = (body) => ({
        contact: /^\s*contact:/im.test(body),
        expires: (body.match(/^\s*expires:\s*(\S+)/im) || [])[1] || null,
      });
      let st = await smallFile(budget, cache, `${final.origin}/.well-known/security.txt`, parse, /^\s*contact:/im);
      if (!st?.found) st = await smallFile(budget, cache, `${final.origin}/security.txt`, parse, /^\s*contact:/im);
      out.securityTxt = st;
    })(),
  );

  // 5. Email security records on the main domain.
  tasks.push((async () => { out.dns = await emailDns(budget, baseDomain(final.hostname)); })());

  // 6. Mozilla HTTP Observatory grade (free, no key).
  tasks.push(
    (async () => {
      try {
        budget.take();
        const r = await fetch(`https://observatory-api.mdn.mozilla.net/api/v2/scan?host=${encodeURIComponent(final.hostname)}`, { method: "POST", signal: AbortSignal.timeout(20000) });
        const j = await r.json();
        out.observatory = j.error ? { error: String(j.error).slice(0, 80) } : { grade: j.grade, score: j.score, failed: j.tests_failed, passed: j.tests_passed, url: j.details_url };
      } catch { out.observatory = { error: "unavailable" }; }
    })(),
  );

  await Promise.allSettled(tasks);

  // 7. Technology and outdated libraries.
  const srcs = out.html ? [...out.html.scripts, ...out.html.styles] : [];
  out.tech = detectTech({ headers: out.headers, html, generator: out.html?.generator, srcs, cookieNames: out.cookies.map((c) => c.name) });
  const { found, unknown } = libsFromUrls(out.html?.scripts || []);
  for (const src of unknown.slice(0, 4)) {
    if (!budget.has(3)) break;
    try {
      const r = await safeFetch(budget, src, cache, { hops: 1, timeout: 6000, headers: { range: "bytes=0-4095", accept: "*/*" } });
      const head = await readText(r.res, 4096);
      const hit = libsFromContent(head, src);
      if (hit && !found.has(hit.name)) found.set(hit.name, hit);
    } catch { /* skip */ }
  }
  out.libs = [...found.values()].map((l) => ({ ...l, src: l.src.slice(0, 200), vulns: vulnsFor(l.name, l.version) }));

  const wp = out.tech.find((t) => t.name === "WordPress" && t.version);
  if (wp && budget.has(1)) {
    try {
      budget.take();
      const r = await fetch("https://api.wordpress.org/core/version-check/1.7/", { signal: AbortSignal.timeout(5000) });
      const latest = (await r.json()).offers?.[0]?.current;
      if (latest) out.wordpress = { version: wp.version, latest, outdated: compareVersions(wp.version, latest) < 0 };
    } catch { /* skip */ }
  }
  return out;
}

function headerObject(headers) {
  const o = {};
  for (const [k, v] of headers) if (k !== "set-cookie") o[k] = v.slice(0, 2000);
  return o;
}

function parseCookie(sc) {
  const parts = sc.split(";").map((s) => s.trim());
  const name = (parts[0] || "").split("=")[0].slice(0, 60);
  const attrs = {};
  for (const p of parts.slice(1)) {
    const [k, ...v] = p.split("=");
    attrs[k.toLowerCase()] = v.join("=") || true;
  }
  return {
    name,
    secure: !!attrs.secure,
    httpOnly: !!attrs.httponly,
    sameSite: typeof attrs.samesite === "string" ? attrs.samesite.toLowerCase() : null,
    session: !attrs.expires && !attrs["max-age"],
  };
}

function robotsBlocksAll(body) {
  let applies = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") applies = val === "*";
    else if (applies && key === "disallow" && val === "/") return true;
  }
  return false;
}

// Fetches a small text file. Returns {found, status, ...extra} or {found:false}. `must` guards against
// sites that answer every address with their home page.
async function smallFile(budget, cache, url, parse, must) {
  try {
    const r = await safeFetch(budget, url, cache, { hops: 3, timeout: 8000, headers: { accept: "text/plain,application/xml,*/*" } });
    const status = r.res.status;
    if (status !== 200) { r.res.body?.cancel(); return { found: false, status }; }
    const body = await readText(r.res, 300_000);
    if (/^\s*<(!doctype html|html)/i.test(body) && !/<(urlset|sitemapindex)/i.test(body)) return { found: false, status, html: true };
    if (must && !must.test(body)) return { found: false, status };
    return { found: true, status, ...parse(body) };
  } catch (e) {
    return { found: false, error: e.code || "error" };
  }
}

async function emailDns(budget, domain) {
  const d = { domain };
  const jobs = [
    txt(budget, domain).then((recs) => {
      const spf = recs.filter((r) => /^v=spf1\b/i.test(r));
      d.spf = spf[0] || null;
      d.spfCount = spf.length;
      d.spfAll = d.spf ? ((d.spf.match(/([-~?+])?all\b/i) || [])[1] || (/\ball\b/i.test(d.spf) ? "+" : null)) : null;
    }),
    txt(budget, `_dmarc.${domain}`).then((recs) => {
      d.dmarc = recs.find((r) => /^v=DMARC1/i.test(r)) || null;
      d.dmarcPolicy = d.dmarc ? ((d.dmarc.match(/\bp=(\w+)/i) || [])[1] || "").toLowerCase() : null;
    }),
    doh(budget, domain, "MX").then((r) => { d.mx = r.answers.some((a) => a.type === 15); d.nullMx = r.answers.some((a) => a.type === 15 && /^0\s+\.$/.test(a.data)); }),
    doh(budget, domain, "CAA").then((r) => { d.caa = r.answers.some((a) => a.type === 257); }),
    Promise.all(DKIM_SELECTORS.map((s) => txt(budget, `${s}._domainkey.${domain}`).then((recs) => (recs.some((r) => /p=/i.test(r) || /v=DKIM1/i.test(r)) ? s : null)).catch(() => null)))
      .then((sel) => { d.dkim = sel.filter(Boolean); }),
  ];
  await Promise.allSettled(jobs);
  return d;
}

// Reads the parts of the page that matter for SEO, mixed content and technology, with the streaming HTML parser.
async function parseHtml(html, base) {
  const r = {
    lang: null, title: null, titleCount: 0, description: null, viewport: null, canonical: null, robots: null, generator: null,
    metaCsp: null, charset: false, favicon: false,
    headings: [], og: {}, twitter: false, jsonld: [], jsonldInvalid: 0,
    images: 0, noAlt: 0, lazy: 0, scripts: [], styles: [], noSri: 0, inlineScripts: 0,
    mixedActive: [], mixedPassive: [], insecureForms: 0, iframes: 0, blankNoOpener: 0,
    links: [], externalLinks: 0,
  };
  const https = base.protocol === "https:";
  const sameSite = (u) => u.hostname === base.hostname || u.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
  const abs = (v) => { try { return new URL(v.trim(), base); } catch { return null; } };
  const mixed = (v, active) => {
    if (!https || !v || !/^\s*http:\/\//i.test(v)) return;
    const list = active ? r.mixedActive : r.mixedPassive;
    if (list.length < 10) list.push(v.trim().slice(0, 200));
  };
  const linkSet = new Set();
  let titleBuf = null, headBuf = null, ldBuf = null;

  const rw = new HTMLRewriter()
    .on("html", { element(e) { r.lang = e.getAttribute("lang"); } })
    .on("title", {
      element() { r.titleCount++; if (r.titleCount === 1) titleBuf = ""; },
      text(t) { if (titleBuf !== null) { titleBuf += t.text; if (t.lastInTextNode) { r.title = decode(titleBuf).trim(); titleBuf = null; } } },
    })
    .on("meta", {
      element(e) {
        const name = (e.getAttribute("name") || "").toLowerCase();
        const prop = (e.getAttribute("property") || "").toLowerCase();
        const content = e.getAttribute("content");
        const equiv = (e.getAttribute("http-equiv") || "").toLowerCase();
        if (e.getAttribute("charset")) r.charset = true;
        if (name === "description") r.description = decode(content || "");
        else if (name === "viewport") r.viewport = content || "";
        else if (name === "referrer") r.metaReferrer = true;
        else if (name === "robots") r.robots = (content || "").toLowerCase();
        else if (name === "generator" && !r.generator) r.generator = (content || "").slice(0, 100);
        else if (name.startsWith("twitter:")) r.twitter = true;
        if (prop.startsWith("og:")) r.og[prop.slice(3)] = (content || "").slice(0, 300);
        if (equiv === "content-security-policy") r.metaCsp = (content || "").slice(0, 2000);
        if (equiv === "content-type") r.charset = true;
      },
    })
    .on("link", {
      element(e) {
        const rel = (e.getAttribute("rel") || "").toLowerCase().split(/\s+/);
        const href = e.getAttribute("href");
        if (rel.includes("canonical")) r.canonical = href;
        if (rel.includes("icon")) r.favicon = true;
        if (rel.includes("stylesheet") && href) {
          mixed(href, true);
          const u = abs(href);
          if (u) { r.styles.push(u.href.slice(0, 300)); if (!sameSite(u) && !e.getAttribute("integrity")) r.noSri++; }
        }
      },
    })
    .on("h1, h2, h3, h4, h5, h6", {
      element(e) { headBuf = { level: +e.tagName.slice(1), text: "" }; r.headings.push(headBuf); },
      text(t) { if (headBuf && headBuf.text.length < 120) headBuf.text += t.text; },
    })
    .on("script", {
      element(e) {
        const src = e.getAttribute("src");
        const type = (e.getAttribute("type") || "").toLowerCase();
        if (type === "application/ld+json") { ldBuf = ""; return; }
        if (src) {
          mixed(src, true);
          const u = abs(src);
          if (u) { if (r.scripts.length < 60) r.scripts.push(u.href.slice(0, 300)); if (!sameSite(u) && !e.getAttribute("integrity")) r.noSri++; }
        } else r.inlineScripts++;
      },
      text(t) {
        if (ldBuf === null) return;
        if (ldBuf.length < 100_000) ldBuf += t.text;
        if (t.lastInTextNode) {
          try {
            const j = JSON.parse(ldBuf);
            const types = [];
            const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") { if (o["@type"]) types.push([].concat(o["@type"]).join("/")); if (o["@graph"]) walk(o["@graph"]); } };
            walk(j);
            r.jsonld.push(...types.slice(0, 10));
            if (!types.length) r.jsonld.push("Thing");
          } catch { r.jsonldInvalid++; }
          ldBuf = null;
        }
      },
    })
    .on("img", {
      element(e) {
        r.images++;
        if (e.getAttribute("alt") === null) r.noAlt++;
        if ((e.getAttribute("loading") || "") === "lazy") r.lazy++;
        mixed(e.getAttribute("src"), false);
      },
    })
    .on("iframe, frame", { element(e) { r.iframes++; mixed(e.getAttribute("src"), true); } })
    .on("video, audio, source", { element(e) { mixed(e.getAttribute("src"), false); } })
    .on("object, embed", { element(e) { mixed(e.getAttribute("data") || e.getAttribute("src"), true); } })
    .on("form", {
      element(e) {
        const action = e.getAttribute("action");
        if (action && /^\s*http:\/\//i.test(action)) r.insecureForms++;
      },
    })
    .on("a", {
      element(e) {
        const href = e.getAttribute("href");
        if (!href || /^\s*(#|mailto:|tel:|javascript:|data:|sms:)/i.test(href)) return;
        const u = abs(href);
        if (!u || !/^https?:$/.test(u.protocol)) return;
        if ((e.getAttribute("target") || "") === "_blank" && !/noopener|noreferrer/i.test(e.getAttribute("rel") || "")) r.blankNoOpener++;
        if (!sameSite(u)) { r.externalLinks++; return; }
        u.hash = "";
        // Cloudflare's own paths (e.g. email obfuscation) answer 404 to anything but a browser.
        if (u.pathname.startsWith("/cdn-cgi/")) return;
        if (u.href !== base.href && linkSet.size < MAX_LINKS) linkSet.add(u.href);
      },
    });

  await rw.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })).text();
  r.links = [...linkSet];
  r.headings = r.headings.slice(0, 60).map((h) => ({ level: h.level, text: decode(h.text).replace(/\s+/g, " ").trim().slice(0, 100) }));
  return r;
}

function decode(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&nbsp;/g, " ");
}
