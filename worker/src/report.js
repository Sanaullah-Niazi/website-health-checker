// Turns the raw results of a scan into issues (code + severity + values), category scores, a grade and the top 5 fixes.
// The page turns each code into plain-English text in the visitor's language (see web_i_* in _data/tools.yml).

const SEV = { critical: 0, high: 1, medium: 2, low: 3 };
const DEDUCT = { critical: 30, high: 15, medium: 7, low: 3 };
export const WEIGHTS = { security: 30, performance: 20, seo: 15, a11y: 15, design: 10, tech: 10 };

export function buildReport({ core, psiMobile, psiDesktop, links, ssl }) {
  const issues = [];
  const add = (cat, sev, code, p = {}, scored = true) => issues.push({ cat, sev, code, p, scored });
  const h = core?.headers || {};
  const html = core?.html;

  if (core && !core.error) {
    // ----- Security -----
    if (!core.https) add("security", "critical", "no_https");
    else if (core.httpRedirect === "none" || core.httpRedirect === "http") add("security", "high", "http_no_redirect");

    if (core.https) {
      const hsts = h["strict-transport-security"];
      if (!hsts) add("security", "medium", "no_hsts");
      else {
        const age = +((hsts.match(/max-age=(\d+)/i) || [])[1] || 0);
        if (age < 15552000) add("security", "low", "hsts_short", { days: Math.round(age / 86400) });
      }
    }
    const csp = h["content-security-policy"] || html?.metaCsp || "";
    if (!csp) add("security", "medium", "no_csp");
    else {
      const scriptSrc = (csp.match(/(?:^|;)\s*script-src\s+([^;]*)/i) || csp.match(/(?:^|;)\s*default-src\s+([^;]*)/i) || [])[1] || "";
      const weak = [];
      if (/'unsafe-inline'/.test(scriptSrc) && !/'nonce-|'sha(256|384|512)-|'strict-dynamic'/.test(scriptSrc)) weak.push("'unsafe-inline'");
      if (/'unsafe-eval'/.test(scriptSrc)) weak.push("'unsafe-eval'");
      if (/(^|\s)(\*|https?:|data:)(\s|$)/.test(scriptSrc)) weak.push("wildcard");
      if (weak.length) add("security", "low", "csp_weak", { what: weak.join(", ") });
    }
    const xfo = h["x-frame-options"];
    if (!xfo && !/frame-ancestors/i.test(h["content-security-policy"] || "")) add("security", "medium", "no_clickjack");
    if (!/nosniff/i.test(h["x-content-type-options"] || "")) add("security", "low", "no_nosniff");
    if (!h["referrer-policy"] && !html?.metaReferrer) add("security", "low", "no_referrer");
    if (!h["permissions-policy"]) add("security", "low", "no_permissions");

    if (core.https) {
      const noSecure = core.cookies.filter((c) => !c.secure).map((c) => c.name);
      if (noSecure.length) add("security", "medium", "cookie_secure", { names: list(noSecure) });
    }
    const sensitive = (n) => /sess|sid|auth|token|login|jwt|remember|csrf|xsrf/i.test(n);
    const noHttpOnly = core.cookies.filter((c) => !c.httpOnly && sensitive(c.name) && !/csrf|xsrf/i.test(c.name)).map((c) => c.name);
    if (noHttpOnly.length) add("security", "medium", "cookie_httponly", { names: list(noHttpOnly) });
    const noSameSite = core.cookies.filter((c) => !c.sameSite || (c.sameSite === "none" && !c.secure)).map((c) => c.name);
    if (noSameSite.length) add("security", "low", "cookie_samesite", { names: list(noSameSite) });

    if (html?.mixedActive.length) add("security", "high", "mixed_active", { n: html.mixedActive.length, example: html.mixedActive[0] });
    if (html?.mixedPassive.length) add("security", "medium", "mixed_passive", { n: html.mixedPassive.length, example: html.mixedPassive[0] });
    if (html?.insecureForms) add("security", "high", "insecure_form", { n: html.insecureForms });
    if (/\d/.test(h.server || "")) add("security", "low", "server_version", { value: h.server.slice(0, 60) });
    const powered = h["x-powered-by"] || h["x-aspnet-version"] || h["x-aspnetmvc-version"] || h["x-generator"];
    if (powered) add("security", "low", "powered_by", { value: powered.slice(0, 60) });
    if (html?.noSri) add("security", "low", "no_sri", { n: html.noSri });

    if (!core.securityTxt?.found) add("security", "low", "no_securitytxt");
    else if (core.securityTxt.expires && Date.parse(core.securityTxt.expires) < Date.now()) add("security", "low", "securitytxt_expired");

    const dns = core.dns || {};
    if (dns.domain) {
      const mail = dns.mx && !dns.nullMx;
      if (!dns.spf) add("security", mail ? "medium" : "low", mail ? "no_spf" : "no_spf_nomail", { domain: dns.domain });
      else {
        if (dns.spfCount > 1) add("security", "medium", "spf_multiple", { domain: dns.domain });
        if (dns.spfAll === "+") add("security", "high", "spf_pass_all", { domain: dns.domain });
        else if (dns.spfAll === "?" || !dns.spfAll) add("security", "medium", "spf_neutral", { domain: dns.domain });
      }
      if (!dns.dmarc) add("security", mail ? "medium" : "low", "no_dmarc", { domain: dns.domain });
      else if (dns.dmarcPolicy === "none") add("security", "low", "dmarc_none", { domain: dns.domain });
      if (mail && !dns.dkim?.length) add("security", "low", "no_dkim", { domain: dns.domain });
    }

    // ----- SEO -----
    if (core.status >= 400) add("seo", "critical", "bad_status", { status: core.status });
    const xRobots = h["x-robots-tag"] || "";
    if (/noindex/i.test(html?.robots || "") || /noindex/i.test(xRobots)) add("seo", "high", "noindex");
    if (core.robots?.found && core.robots.disallowAll) add("seo", "critical", "robots_block_all");
    if (html) {
      if (!html.title) add("seo", "high", "no_title");
      else if (html.title.length > 60) add("seo", "low", "title_long", { n: html.title.length });
      else if (html.title.length < 10) add("seo", "low", "title_short", { n: html.title.length });
      if (!html.description) add("seo", "medium", "no_description");
      else if (html.description.length < 50 || html.description.length > 160) add("seo", "low", "desc_length", { n: html.description.length });
      const h1 = html.headings.filter((x) => x.level === 1).length;
      if (!h1) add("seo", "medium", "no_h1");
      else if (h1 > 1) add("seo", "low", "multi_h1", { n: h1 });
      let prev = 0, skip = null;
      for (const x of html.headings) { if (prev && x.level > prev + 1 && !skip) skip = `h${prev} → h${x.level}`; prev = x.level; }
      if (skip) add("seo", "low", "heading_skip", { what: skip });
      if (!html.canonical) add("seo", "low", "no_canonical");
      const ogMissing = ["title", "description", "image"].filter((k) => !html.og[k]);
      if (ogMissing.length) add("seo", "low", "no_og", { missing: ogMissing.map((k) => "og:" + k).join(", ") });
      if (!html.jsonld.length && !html.jsonldInvalid) add("seo", "low", "no_jsonld");
      if (html.jsonldInvalid) add("seo", "medium", "jsonld_invalid", { n: html.jsonldInvalid });
      if (html.noAlt) add("seo", html.noAlt >= 5 ? "medium" : "low", "img_alt", { n: html.noAlt, total: html.images });
    }
    if (!core.robots?.found) add("seo", "low", "no_robots");
    if (!core.sitemap?.found || !core.sitemap.valid) add("seo", "low", "no_sitemap");

    // ----- Accessibility (own checks) -----
    if (html && !html.lang) add("a11y", "medium", "no_lang");
    if (html?.viewport && /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(html.viewport)) add("a11y", "medium", "zoom_disabled");

    // ----- Design and mobile -----
    if (html) {
      if (!html.viewport) add("design", "high", "no_viewport");
      else if (!/width\s*=\s*device-width/i.test(html.viewport)) add("design", "medium", "viewport_bad");
      if (!html.favicon) add("design", "low", "no_favicon");
    }

    // ----- Performance (own checks) -----
    if (core.ms > 1800) add("performance", "medium", "slow_server", { ms: core.ms }, false);
    else if (core.ms > 800) add("performance", "low", "slow_server", { ms: core.ms }, false);
    if (core.bytes > 20000 && !h["content-encoding"]) add("performance", "low", "no_compression", { kb: Math.round(core.bytes / 1024) }, false);

    // ----- Technology -----
    for (const lib of core.libs || []) {
      if (!lib.vulns?.length) continue;
      const worst = lib.vulns.map((v) => (v.severity || "medium").toLowerCase()).sort((x, y) => SEV[x] - SEV[y])[0];
      const cves = [...new Set(lib.vulns.flatMap((v) => v.cve || []))].slice(0, 4).join(", ");
      add("tech", SEV[worst] !== undefined ? worst : "medium", "vuln_lib", { name: lib.name, version: lib.version, n: lib.vulns.length, cves: cves || "—", summary: lib.vulns[0].summary || "" });
    }
    if (core.wordpress?.outdated) add("tech", "high", "wp_outdated", { version: core.wordpress.version, latest: core.wordpress.latest });
    if (html?.generator && /\d/.test(html.generator)) add("tech", "low", "generator_version", { value: html.generator });
  }

  // ----- Links -----
  const broken = links.flatMap((l) => l?.broken || []);
  const checked = links.reduce((n, l) => n + (l?.checked || 0), 0);
  if (broken.length) add("seo", broken.length >= 5 ? "high" : "medium", "broken_links", { n: broken.length, checked, example: broken[0].url });

  // ----- SSL Labs -----
  if (ssl?.status === "ready") {
    const g = ssl.grade || "";
    if (/^[EFTM]/.test(g)) add("security", "critical", "ssl_grade", { grade: g });
    else if (/^[CD]/.test(g)) add("security", "high", "ssl_grade", { grade: g });
    else if (/^B/.test(g)) add("security", "medium", "ssl_grade", { grade: g });
    if (ssl.cert?.notAfter) {
      const days = Math.floor((ssl.cert.notAfter - Date.now()) / 86400000);
      if (days < 0) add("security", "critical", "cert_expired", { days: -days });
      else if (days <= 14) add("security", "high", "cert_expiring", { days });
      else if (days <= 30) add("security", "medium", "cert_expiring", { days });
    }
    if (ssl.protocols.some((p) => /TLS 1\.[01]$|SSL/.test(p))) add("security", "medium", "old_tls", { list: ssl.protocols.filter((p) => /TLS 1\.[01]$|SSL/.test(p)).join(", ") });
    if (!ssl.protocols.some((p) => /TLS 1\.3/.test(p))) add("security", "low", "no_tls13");
    if (ssl.heartbleed || ssl.poodle) add("security", "critical", "ssl_vuln", { name: ssl.heartbleed ? "Heartbleed" : "POODLE" });
  }

  // ----- Lighthouse (PageSpeed) -----
  const m = psiMobile && !psiMobile.error ? psiMobile : null;
  const d = psiDesktop && !psiDesktop.error ? psiDesktop : null;
  if (m || d) {
    const main = m || d;
    const perf = main.scores.performance;
    if (perf !== null && perf < 50) add("performance", "high", "perf_score", { score: perf, device: m ? "mobile" : "desktop" }, false);
    else if (perf !== null && perf < 90) add("performance", "medium", "perf_score", { score: perf, device: m ? "mobile" : "desktop" }, false);
    const f = main.field || main.originField;
    const lcp = f?.lcp?.p75 ?? main.lab.lcp;
    if (lcp > 4000) add("performance", "high", "lcp", { s: (lcp / 1000).toFixed(1) }, false);
    else if (lcp > 2500) add("performance", "medium", "lcp", { s: (lcp / 1000).toFixed(1) }, false);
    const cls = f?.cls?.p75 ?? main.lab.cls;
    if (cls > 0.25) add("performance", "high", "cls", { v: cls.toFixed(2) }, false);
    else if (cls > 0.1) add("performance", "medium", "cls", { v: cls.toFixed(2) }, false);
    if (f?.inp?.p75 > 500) add("performance", "high", "inp", { ms: f.inp.p75 }, false);
    else if (f?.inp?.p75 > 200) add("performance", "medium", "inp", { ms: f.inp.p75 }, false);
    else if (!f?.inp && main.lab.tbt > 600) add("performance", "medium", "tbt", { ms: Math.round(main.lab.tbt) }, false);
    for (const o of main.opportunities.slice(0, 3)) add("performance", o.savingsMs >= 1000 ? "medium" : "low", "lh", lh(o, { savings: (o.savingsMs / 1000).toFixed(1) }), false);
    const a11y = main.scores.accessibility;
    if (a11y !== null && a11y < 50) add("a11y", "high", "a11y_score", { score: a11y }, false);
    else if (a11y !== null && a11y < 90) add("a11y", "medium", "a11y_score", { score: a11y }, false);
    for (const x of main.a11y.slice(0, 6)) add("a11y", (x.weight || 0) >= 7 ? "medium" : "low", "lh", lh(x), false);
    for (const x of main.bestPractices.slice(0, 4)) add("a11y", "low", "lh", lh(x), false);
    for (const x of main.seo.filter((x) => !["document-title", "meta-description", "image-alt", "is-crawlable", "canonical", "robots-txt"].includes(x.id)).slice(0, 3)) add("seo", "low", "lh", lh(x), false);
    for (const x of main.design) add("design", ["color-contrast", "font-size", "tap-targets", "target-size"].includes(x.id) ? "medium" : "low", "lh", lh(x), true);
  }

  // ----- Scores -----
  const ded = (cat) => issues.filter((i) => i.cat === cat && i.scored).reduce((n, i) => n + DEDUCT[i.sev], 0);
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
  const scores = {};
  if (core && !core.error) {
    scores.security = clamp(100 - ded("security"));
    if (issues.some((i) => i.cat === "security" && i.sev === "critical")) scores.security = Math.min(scores.security, 49);
    scores.design = clamp(100 - ded("design"));
    scores.tech = clamp(100 - ded("tech"));
    scores.seo = clamp(100 - ded("seo"));
  }
  if (m || d) {
    const pm = m?.scores.performance, pd = d?.scores.performance;
    scores.performance = pm != null && pd != null ? clamp(pm * 0.6 + pd * 0.4) : pm ?? pd ?? undefined;
    const main = m || d;
    const lhA = [main.scores.accessibility, main.scores.bestPractices].filter((x) => x != null);
    if (lhA.length) scores.a11y = clamp(lhA.reduce((a, b) => a + b, 0) / lhA.length - ded("a11y"));
    if (main.scores.seo != null && scores.seo != null) scores.seo = clamp((scores.seo + main.scores.seo) / 2);
  }
  let total = 0, weight = 0;
  for (const [cat, w] of Object.entries(WEIGHTS)) if (typeof scores[cat] === "number") { total += scores[cat] * w; weight += w; }
  const overall = weight ? Math.round(total / weight) : null;
  const grade = overall === null ? null : overall >= 90 ? "A" : overall >= 80 ? "B" : overall >= 70 ? "C" : overall >= 60 ? "D" : "F";

  issues.sort((a, b) => SEV[a.sev] - SEV[b.sev] || WEIGHTS[b.cat] - WEIGHTS[a.cat] || (b.scored ? 1 : 0) - (a.scored ? 1 : 0));
  const top = issues.slice(0, 5).map((_, i) => i);
  return { overall, grade, scores, issues, top };
}

function list(names) {
  const u = [...new Set(names)];
  return u.slice(0, 5).join(", ") + (u.length > 5 ? ` +${u.length - 5}` : "");
}

function lh(x, extra = {}) {
  return { id: x.id, title: x.title, description: x.description, display: x.display, ...extra };
}
