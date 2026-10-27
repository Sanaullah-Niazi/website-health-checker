// Website Health & Security Checker (/tools/website-health-checker/).
// The checks run on a Cloudflare Worker (worker/ in this repository); this file asks it to scan, shows progress,
// and draws the report. A report link (?r=<id>) opens a saved report without scanning again.
// Like tools.js, it builds everything with DOM nodes, never innerHTML, so text from scanned sites can't run as code.
(function () {
  var box = document.getElementById("web");
  if (!box) return;
  var API = (box.getAttribute("data-api") || "").replace(/\/+$/, "");
  var SITEKEY = box.getAttribute("data-sitekey") || "";
  var form = document.getElementById("web-form");
  var input = document.getElementById("web-url");
  var button = document.getElementById("web-check");
  var progress = document.getElementById("web-progress");
  var out = document.getElementById("web-report");

  // ---------- Text (from the "js:" part of _data/tools.yml) ----------
  var TEXT = {};
  try { TEXT = JSON.parse(document.getElementById("tools-text").textContent) || {}; } catch (e) {}
  var root = document.documentElement, rtl = root.getAttribute("dir") === "rtl", lang = root.getAttribute("lang") || "en";
  function tr(key, vars) {
    var s = TEXT[key] || key;
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return k in vars ? (rtl ? "⁨" + vars[k] + "⁩" : String(vars[k])) : m; });
    return s;
  }
  function langCode() { return { ur: "ur", de: "de" }[lang] || (lang.indexOf("zh") === 0 ? "zh" : "en"); }
  function fmtDate(ms, withTime) {
    try { return new Intl.DateTimeFormat(lang, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "long" }).format(new Date(ms)); }
    catch (e) { return new Date(ms).toISOString().slice(0, 10); }
  }
  function num(n, d) { return new Intl.NumberFormat(lang, { maximumFractionDigits: d || 0 }).format(n); }

  // h("p", { class: "x" }, "text", childNode, ...)
  function h(tag, attrs) {
    var el = document.createElement(tag);
    for (var k in attrs || {}) {
      if (attrs[k] === null || attrs[k] === undefined || attrs[k] === false) continue;
      if (k === "text") el.textContent = attrs[k]; else el.setAttribute(k, attrs[k]);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(typeof x === "string" ? document.createTextNode(x) : x); });
      else el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  }
  function fill(el) {
    el.textContent = "";
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) el.appendChild(arguments[i]);
  }
  function ltr(text) { return h("bdi", { dir: "ltr" }, String(text)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------- Talking to the Worker ----------
  function api(path, opts) {
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.error) { var e = new Error(j.error || "http_" + r.status); e.code = j.error || "generic"; throw e; }
        return j;
      });
    });
  }
  function errText(code) {
    var key = "w_err_" + code;
    return TEXT[key] ? tr(key) : tr("w_err_generic");
  }

  // ---------- CAPTCHA (Cloudflare Turnstile) ----------
  var widget = null;
  function renderCaptcha() {
    if (!SITEKEY || widget !== null) return;
    if (!window.turnstile) { setTimeout(renderCaptcha, 300); return; }
    widget = window.turnstile.render("#web-captcha", {
      sitekey: SITEKEY,
      action: "scan",
      theme: root.getAttribute("data-theme") === "dark" ? "dark" : "auto",
      language: langCode() === "zh" ? "zh-cn" : langCode(),
      size: "flexible",
    });
  }

  // ---------- Scanning ----------
  var STEPS = [
    { id: "core", key: "w_step_core" },
    { id: "psi-mobile", key: "w_step_psi_m" },
    { id: "psi-desktop", key: "w_step_psi_d" },
    { id: "links", key: "w_step_links" },
    { id: "ssl", key: "w_step_ssl" },
  ];
  var stepEls = {};
  function showSteps(host) {
    var ul = h("ul", { class: "web-steps" });
    STEPS.forEach(function (s) {
      var state = h("span", { class: "web-step-state", text: tr("w_running") });
      stepEls[s.id] = { li: h("li", { class: "is-running" }, h("span", { class: "web-step-dot", "aria-hidden": "true" }), h("span", null, tr(s.key)), state), state: state };
      ul.appendChild(stepEls[s.id].li);
    });
    fill(progress, h("p", { class: "tool-msg" }, tr("w_working", { h: host })), ul);
  }
  function setStep(id, state, label) {
    var s = stepEls[id];
    if (!s) return;
    s.li.className = "is-" + state;
    s.state.textContent = label || tr({ done: "w_done", failed: "w_failed", skipped: "w_skipped", running: "w_running" }[state]);
  }

  var current = null; // { id, key }
  var sslTimer = null;

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    startScan(false);
  });

  function startScan(fresh) {
    var url = input.value.trim();
    if (!url || url.length > 2000 || !/^(https?:\/\/)?[^\s\/?#]+\.[^\s\/?#]+/i.test(url)) { fill(progress, h("p", { class: "tool-msg bad" }, tr("w_bad_url"))); input.focus(); return; }
    var token = window.turnstile && widget !== null ? window.turnstile.getResponse(widget) : "";
    if (!token) { fill(progress, h("p", { class: "tool-msg bad" }, tr("w_need_captcha"))); return; }
    clearTimeout(sslTimer);
    button.disabled = true;
    out.hidden = true;
    document.body.classList.remove("has-web-report");
    var host = url.replace(/^https?:\/\//i, "").split(/[\/?#]/)[0];
    showSteps(host);
    api("/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: url, token: token, lang: langCode(), fresh: !!fresh }) })
      .then(function (s) {
        current = { id: s.id, key: s.key };
        if (s.cached) { STEPS.forEach(function (x) { setStep(x.id, "done"); }); return loadReport(s.id, true); }
        return runParts(s);
      })
      .catch(function (e) { fill(progress, h("p", { class: "tool-msg bad" }, errText(e.code))); })
      .then(function () {
        button.disabled = false;
        if (window.turnstile && widget !== null) window.turnstile.reset(widget);
      });
  }

  function part(name) {
    return api("/scan/" + current.id + "/" + name, { method: "POST", headers: { "x-scan-key": current.key } });
  }

  function runParts(s) {
    var core = part("core").then(function (r) {
      setStep("core", r.ok ? "done" : "failed", r.ok ? null : errText(r.error));
      if (!r.ok || !r.links) { setStep("links", "skipped"); return; }
      var batches = [part("links-0")];
      if (r.links > 25) batches.push(part("links-1"));
      return Promise.all(batches).then(function () { setStep("links", "done"); }, function () { setStep("links", "failed"); });
    }, function () { setStep("core", "failed"); setStep("links", "skipped"); });
    var psi = ["psi-mobile", "psi-desktop"].map(function (p) {
      return part(p).then(function (r) { setStep(p, r.ok ? "done" : "failed"); }, function () { setStep(p, "failed"); });
    });
    var ssl = s.ssl ? pollSsl(Date.now() + 25000) : Promise.resolve(setStep("ssl", "skipped"));
    // The report is shown once everything but a slow SSL Labs test is done; SSL keeps polling and fills in later.
    return Promise.all([core].concat(psi)).then(function () {
      return Promise.race([ssl, sleep(1500)]);
    }).then(function () { return loadReport(current.id, false); });
  }

  // Asks SSL Labs (through the Worker) every 10 seconds. Resolves when ready, failed, or `until` passes.
  function pollSsl(until) {
    return part("ssl").then(function (r) {
      if (r.status === "pending" || r.status === "busy") {
        setStep("ssl", "running", r.progress ? num(r.progress) + "%" : tr("w_running"));
        if (Date.now() > until) { sslTimer = setTimeout(function () { pollSsl(Infinity).then(function () { loadReport(current.id, false, true); }); }, 10000); return; }
        return sleep(10000).then(function () { return pollSsl(until); });
      }
      setStep("ssl", r.status === "ready" ? "done" : r.status === "off" ? "skipped" : "failed");
    }, function () { setStep("ssl", "failed"); });
  }

  function loadReport(id, cached, quiet) {
    return api("/report/" + encodeURIComponent(id)).then(function (data) {
      renderReport(data, cached);
      if (!quiet) {
        progress.textContent = "";
        try { history.replaceState(null, "", location.pathname + "?r=" + encodeURIComponent(id)); } catch (e) {}
        out.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  // ---------- Report ----------
  var CATS = ["security", "performance", "seo", "a11y", "design", "tech"];
  function scoreClass(n) { return n == null ? "na" : n >= 90 ? "a" : n >= 70 ? "b" : n >= 50 ? "c" : "f"; }

  function ring(score, grade) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 120 120");
    svg.setAttribute("class", "web-ring g-" + scoreClass(score));
    svg.setAttribute("aria-hidden", "true");
    var bg = document.createElementNS(NS, "circle");
    var fg = document.createElementNS(NS, "circle");
    [bg, fg].forEach(function (c) { c.setAttribute("cx", "60"); c.setAttribute("cy", "60"); c.setAttribute("r", "52"); });
    bg.setAttribute("class", "web-ring-bg");
    fg.setAttribute("class", "web-ring-fg");
    var len = 2 * Math.PI * 52;
    fg.setAttribute("stroke-dasharray", len.toFixed(1));
    fg.setAttribute("stroke-dashoffset", (len * (1 - (score || 0) / 100)).toFixed(1));
    svg.appendChild(bg); svg.appendChild(fg);
    return h("div", { class: "web-ring-wrap" }, svg,
      h("div", { class: "web-ring-text" }, h("strong", null, score == null ? "–" : num(score)), h("span", null, "/100")),
      h("span", { class: "web-grade g-" + scoreClass(score), "aria-label": tr("w_grade") + " " + (grade || "–") }, grade || "–"));
  }

  function bar(cat, score) {
    // Width is set through el.style: the site's security policy blocks style="" attributes.
    var fillEl = h("i", { class: "g-" + scoreClass(score) });
    fillEl.style.width = (score == null ? 0 : score) + "%";
    return h("li", null,
      h("a", { href: "#web-cat-" + cat }, tr("cat_" + cat)),
      h("span", { class: "web-bar", "aria-hidden": "true" }, fillEl),
      h("b", { class: "g-" + scoreClass(score) }, score == null ? tr("w_na") : num(score)));
  }

  // Lighthouse descriptions are short Markdown: keep the text, turn [text](url) into a "Learn more" link.
  function lhParts(md) {
    var link = null;
    var text = String(md || "").replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, function (m, t, u) { if (!link) link = u; return t; }).replace(/`/g, "");
    return { text: text.trim(), link: link };
  }

  // Title, meaning and fix of an issue in the visitor's language (also used by the PDF).
  function issueText(issue) {
    if (issue.code === "lh") {
      var d = lhParts(issue.p.description);
      return {
        title: issue.p.title + (issue.p.savings ? " (−" + num(+issue.p.savings, 1) + " s)" : issue.p.display ? " (" + issue.p.display + ")" : ""),
        what: d.text, fix: tr("w_lh_fix"), link: d.link,
      };
    }
    var p = issue.p;
    if (p.device) { p = Object.assign({}, p); p.device = tr("w_" + p.device); }
    return { title: tr("wi_" + issue.code, p), what: tr("wi_" + issue.code + "_w", p), fix: tr("wi_" + issue.code + "_f", p), link: null };
  }

  function issueCard(issue, idx) {
    var t = issueText(issue);
    return h("li", { class: "web-issue sev-" + issue.sev },
      h("div", { class: "web-issue-head" },
        idx != null ? h("span", { class: "web-issue-n" }, num(idx + 1)) : null,
        h("span", { class: "web-sev sev-" + issue.sev }, tr("sev_" + issue.sev)),
        h("h4", null, t.title)),
      t.what ? h("p", null, h("strong", null, tr("w_what") + ": "), t.what) : null,
      h("p", null, h("strong", null, tr("w_fix") + ": "), t.fix, t.link ? " " : null, t.link ? h("a", { href: t.link, rel: "noopener noreferrer", target: "_blank" }, tr("w_learn")) : null));
  }

  function facts(rows) {
    var dl = h("dl", { class: "web-facts" });
    rows.forEach(function (r) {
      if (!r) return;
      dl.appendChild(h("div", { class: r[2] ? "is-" + r[2] : null }, h("dt", null, r[0]), h("dd", null, r[1])));
    });
    return dl;
  }
  function yn(v) { return v ? tr("w_yes") : tr("w_no"); }
  function ok(v) { return v ? "ok" : "bad"; }

  function cwvRating(metric, v) {
    var t = { lcp: [2500, 4000], cls: [0.1, 0.25], inp: [200, 500], tbt: [200, 600] }[metric];
    return v <= t[0] ? "ok" : v <= t[1] ? "warn" : "bad";
  }
  function cwvLabel(r) { return tr({ ok: "w_good", warn: "w_ni", bad: "w_poor" }[r]); }

  function securityFacts(d) {
    var c = d.core || {}, hd = c.headers || {}, html = c.html || {}, ssl = d.ssl, rows = [];
    if (!d.core || c.error) return null;
    rows.push([tr("w_https"), yn(c.https), ok(c.https)]);
    if (c.https && c.httpRedirect) rows.push([tr("w_redirect"), yn(c.httpRedirect === "https"), ok(c.httpRedirect === "https")]);
    if (!ssl || ssl.status === "off") rows.push([tr("w_ssl_grade"), tr("w_ssl_off")]);
    else if (ssl.status === "ready") {
      rows.push([tr("w_ssl_grade"), ssl.grade || "–", /^A/.test(ssl.grade || "") ? "ok" : "bad"]);
      if (ssl.cert && ssl.cert.notAfter) rows.push([tr("w_cert_exp"), fmtDate(ssl.cert.notAfter), ssl.cert.notAfter - Date.now() > 30 * 86400000 ? "ok" : "bad"]);
      if (ssl.cert && ssl.cert.issuer) rows.push([tr("w_cert_issuer"), ltr(ssl.cert.issuer)]);
      if (ssl.protocols && ssl.protocols.length) rows.push([tr("w_protocols"), ltr(ssl.protocols.join(", "))]);
    } else if (ssl.status === "pending" || ssl.status === "busy") rows.push([tr("w_ssl_grade"), tr("w_ssl_pending", { n: num(ssl.progress || 0) })]);
    else rows.push([tr("w_ssl_grade"), tr("w_ssl_error", { e: ssl.error || "?" })]);
    if (c.observatory && c.observatory.grade) rows.push([tr("w_observatory"), c.observatory.grade, /^[AB]/.test(c.observatory.grade) ? "ok" : "bad"]);
    var csp = hd["content-security-policy"] || html.metaCsp;
    var hdrs = [
      ["Content-Security-Policy", !!csp],
      ["Strict-Transport-Security", !!hd["strict-transport-security"]],
      ["X-Frame-Options / frame-ancestors", !!hd["x-frame-options"] || /frame-ancestors/i.test(hd["content-security-policy"] || "")],
      ["X-Content-Type-Options", /nosniff/i.test(hd["x-content-type-options"] || "")],
      ["Referrer-Policy", !!hd["referrer-policy"] || !!html.metaReferrer],
      ["Permissions-Policy", !!hd["permissions-policy"]],
    ];
    var list = h("ul", { class: "web-checks" });
    hdrs.forEach(function (x) { list.appendChild(h("li", { class: "is-" + ok(x[1]) }, ltr(x[0]), " ", h("span", null, x[1] ? tr("w_present") : tr("w_missing")))); });
    rows.push([tr("w_headers"), list]);
    rows.push([tr("w_cookies"), c.cookies && c.cookies.length ? ltr(c.cookies.map(function (k) { return k.name; }).join(", ")) : tr("w_none")]);
    var dns = c.dns || {};
    if (dns.domain) {
      var mail = h("ul", { class: "web-checks" },
        h("li", { class: "is-" + ok(dns.spf) }, "SPF ", dns.spf ? h("code", { dir: "ltr" }, dns.spf.slice(0, 160)) : h("span", null, tr("w_not_found"))),
        h("li", { class: "is-" + ok(dns.dmarc) }, "DMARC ", dns.dmarc ? h("code", { dir: "ltr" }, dns.dmarc.slice(0, 160)) : h("span", null, tr("w_not_found"))),
        h("li", { class: "is-" + (dns.dkim && dns.dkim.length ? "ok" : "warn") }, "DKIM ", h("span", null, dns.dkim && dns.dkim.length ? tr("w_found") + " (" + dns.dkim.join(", ") + ")" : tr("w_not_found"))));
      rows.push([tr("w_email") + " · " + dns.domain, mail]);
    }
    rows.push([tr("w_securitytxt"), c.securityTxt && c.securityTxt.found ? tr("w_found") : tr("w_not_found"), ok(c.securityTxt && c.securityTxt.found)]);
    return facts(rows);
  }

  function performanceFacts(d) {
    var m = d.psi.mobile, k = d.psi.desktop, rows = [];
    var err = function (p) { return p && p.error ? tr("w_psi_error", { e: p.error }) : null; };
    if ((!m || m.error) && (!k || k.error)) return facts([[tr("w_scores"), err(m) || err(k) || tr("w_na")]]);
    rows.push([tr("w_mobile"), m && !m.error ? num(m.scores.performance) + "/100" : err(m), m && !m.error ? (m.scores.performance >= 90 ? "ok" : "bad") : null]);
    rows.push([tr("w_desktop"), k && !k.error ? num(k.scores.performance) + "/100" : err(k), k && !k.error ? (k.scores.performance >= 90 ? "ok" : "bad") : null]);
    var main = m && !m.error ? m : k;
    var f = main.field || main.originField;
    var table = h("table", { class: "web-cwv" });
    table.appendChild(h("tr", null, h("th", null, ""), h("th", null, f ? tr("w_field") : tr("w_lab"))));
    var add = function (label, metric, v, text) {
      if (v == null) return;
      var r = cwvRating(metric, v);
      table.appendChild(h("tr", null, h("th", { scope: "row" }, label), h("td", { class: "is-" + r }, text, " · ", cwvLabel(r))));
    };
    if (f) {
      if (f.lcp) add(tr("w_lcp"), "lcp", f.lcp.p75, num(f.lcp.p75 / 1000, 1) + " s");
      if (f.cls) add(tr("w_cls"), "cls", f.cls.p75, num(f.cls.p75, 2));
      if (f.inp) add(tr("w_inp"), "inp", f.inp.p75, num(f.inp.p75) + " ms");
    } else {
      add(tr("w_lcp"), "lcp", main.lab.lcp, num(main.lab.lcp / 1000, 1) + " s");
      add(tr("w_cls"), "cls", main.lab.cls, num(main.lab.cls, 2));
      add(tr("w_tbt"), "tbt", main.lab.tbt, num(main.lab.tbt) + " ms");
    }
    rows.push([tr("w_cwv"), table]);
    if (d.core && d.core.ms) rows.push([tr("w_server_time"), num(d.core.ms) + " ms", d.core.ms < 800 ? "ok" : "bad"]);
    return facts(rows);
  }

  function seoFacts(d) {
    var c = d.core, html = c && c.html;
    if (!html) return null;
    var h1 = html.headings.filter(function (x) { return x.level === 1; });
    var brokenAll = [];
    d.links.forEach(function (l) { brokenAll = brokenAll.concat(l.broken || []); });
    var checked = d.links.reduce(function (n, l) { return n + (l.checked || 0); }, 0);
    var brokenList = brokenAll.length ? h("ul", { class: "web-checks" }, brokenAll.slice(0, 10).map(function (b) { return h("li", { class: "is-bad" }, ltr(b.url), " ", h("span", null, b.status ? String(b.status) : b.error)); })) : tr("w_none");
    return facts([
      [tr("w_title_tag"), html.title ? h("span", null, ltr(html.title), " · ", tr("w_chars", { n: html.title.length })) : tr("w_not_found"), ok(html.title)],
      [tr("w_desc"), html.description ? h("span", null, ltr(html.description), " · ", tr("w_chars", { n: html.description.length })) : tr("w_not_found"), ok(html.description)],
      [tr("w_h1"), h1.length ? ltr(h1.map(function (x) { return x.text; }).join(" | ")) : tr("w_not_found"), ok(h1.length === 1)],
      [tr("w_canonical"), html.canonical ? ltr(html.canonical) : tr("w_not_found"), ok(html.canonical)],
      [tr("w_robots"), c.robots && c.robots.found ? tr("w_found") : tr("w_not_found"), ok(c.robots && c.robots.found)],
      [tr("w_sitemap"), c.sitemap && c.sitemap.found ? ltr(c.sitemap.url) : tr("w_not_found"), ok(c.sitemap && c.sitemap.found)],
      [tr("w_og"), Object.keys(html.og).length ? ltr(Object.keys(html.og).map(function (k) { return "og:" + k; }).join(", ")) : tr("w_not_found"), ok(html.og.title && html.og.image)],
      [tr("w_schema"), html.jsonld.length ? ltr(html.jsonld.join(", ")) : tr("w_not_found"), ok(html.jsonld.length)],
      [tr("w_alt"), num(html.noAlt) + " / " + num(html.images), ok(!html.noAlt)],
      checked ? [tr("w_links"), num(checked)] : null,
      checked ? [tr("w_broken"), brokenList, ok(!brokenAll.length)] : null,
    ]);
  }

  function a11yFacts(d) {
    var m = d.psi.mobile && !d.psi.mobile.error ? d.psi.mobile : d.psi.desktop && !d.psi.desktop.error ? d.psi.desktop : null;
    var html = d.core && d.core.html;
    return facts([
      m ? [tr("w_a11y_score"), num(m.scores.accessibility) + "/100", m.scores.accessibility >= 90 ? "ok" : "bad"] : null,
      m ? [tr("w_bp_score"), num(m.scores.bestPractices) + "/100", m.scores.bestPractices >= 90 ? "ok" : "bad"] : null,
      html ? [tr("w_lang"), html.lang ? ltr(html.lang) : tr("w_no"), ok(html.lang)] : null,
    ]);
  }

  function designFacts(d) {
    var html = d.core && d.core.html;
    var shots = h("div", { class: "web-shots" });
    if (d.shots.desktop) shots.appendChild(h("figure", { class: "web-shot-desktop" }, h("img", { src: d.shots.desktop, alt: tr("w_desktop") }), h("figcaption", null, tr("w_desktop"))));
    if (d.shots.mobile) shots.appendChild(h("figure", { class: "web-shot-mobile" }, h("img", { src: d.shots.mobile, alt: tr("w_mobile") }), h("figcaption", null, tr("w_mobile"))));
    return h("div", null,
      html ? facts([[tr("w_viewport"), html.viewport ? ltr(html.viewport) : tr("w_not_found"), ok(html.viewport && /device-width/.test(html.viewport))]]) : null,
      shots.childNodes.length ? h("h4", { class: "web-sub" }, tr("w_screens")) : null,
      shots.childNodes.length ? shots : null);
  }

  function techFacts(d) {
    var c = d.core;
    if (!c || c.error) return null;
    var chips = h("ul", { class: "web-chips" });
    (c.tech || []).forEach(function (t) { chips.appendChild(h("li", null, ltr(t.name + (t.version ? " " + t.version : "")))); });
    var libs = h("ul", { class: "web-checks" });
    (c.libs || []).forEach(function (l) {
      var n = (l.vulns || []).length;
      libs.appendChild(h("li", { class: "is-" + (n ? "bad" : "ok") }, ltr(l.name + " " + l.version), " ", h("span", null, n ? tr("w_vulns", { n: n }) : tr("w_no_vulns"))));
    });
    return facts([
      [tr("w_tech"), chips.childNodes.length ? chips : tr("w_tech_none")],
      libs.childNodes.length ? [tr("w_libs"), libs] : null,
    ]);
  }

  var FACTS = { security: securityFacts, performance: performanceFacts, seo: seoFacts, a11y: a11yFacts, design: designFacts, tech: techFacts };

  function renderReport(d, cached) {
    var r = d.report;
    var shareUrl = location.origin + location.pathname + "?r=" + encodeURIComponent(d.id);
    var shareBtn = h("button", { class: "btn btn-sm", type: "button" }, h("span", null, tr("w_share")));
    shareBtn.addEventListener("click", function () {
      var label = shareBtn.querySelector("span");
      var done = function () { label.textContent = tr("w_copied"); setTimeout(function () { label.textContent = tr("w_share"); }, 1800); };
      if (navigator.clipboard) navigator.clipboard.writeText(shareUrl).then(done, function () { prompt("", shareUrl); });
      else prompt("", shareUrl);
    });
    var pdfBtn = h("button", { class: "btn btn-primary btn-sm", type: "button" }, h("span", null, tr("w_pdf")));
    pdfBtn.addEventListener("click", function () { downloadPdf(d, pdfBtn); });
    var freshBtn = h("button", { class: "btn btn-sm", type: "button" }, h("span", null, tr("w_fresh")));
    freshBtn.addEventListener("click", function () {
      input.value = d.url;
      form.scrollIntoView({ behavior: "smooth", block: "center" });
      startScan(true);
    });
    var bars = h("ul", { class: "web-bars" });
    CATS.forEach(function (c) { bars.appendChild(bar(c, r.scores[c])); });
    var missing = CATS.some(function (c) { return r.scores[c] == null; });

    var head = h("header", { class: "card web-summary" },
      h("p", { class: "web-printonly web-brand" }, document.title.split(" | ").pop() + " · " + location.host + location.pathname),
      h("div", { class: "web-summary-main" },
        ring(r.overall, r.grade),
        h("div", { class: "web-summary-text" },
          h("p", { class: "eyebrow" }, tr("w_report_title")),
          h("h2", null, ltr(d.host)),
          h("p", { class: "muted" }, ltr(d.url)),
          h("p", { class: "muted" }, tr("w_scanned", { t: fmtDate(d.created, true) })),
          bars)),
      cached ? h("p", { class: "tool-note web-noprint" }, tr("w_cached", { t: fmtDate(d.created, true) })) : null,
      missing ? h("p", { class: "tool-note" }, tr("w_partial")) : null,
      h("div", { class: "btn-row web-noprint" }, pdfBtn, shareBtn, freshBtn));

    var top = h("section", { class: "card web-top", "aria-labelledby": "web-top-title" }, h("h3", { id: "web-top-title" }, tr("w_top5")));
    if (r.top.length) {
      var ol = h("ol", { class: "web-issues" });
      r.top.forEach(function (i, n) { ol.appendChild(issueCard(r.issues[i], n)); });
      top.appendChild(ol);
    } else top.appendChild(h("p", { class: "tool-msg ok" }, tr("w_top5_none")));

    var sections = CATS.map(function (cat) {
      var list = r.issues.filter(function (i) { return i.cat === cat; });
      var ul = h("ul", { class: "web-issues" });
      list.forEach(function (i) { ul.appendChild(issueCard(i)); });
      var f = FACTS[cat](d);
      return h("section", { class: "card web-cat", id: "web-cat-" + cat, "aria-labelledby": "web-cat-" + cat + "-t" },
        h("div", { class: "web-cat-head" },
          h("h3", { id: "web-cat-" + cat + "-t" }, tr("cat_" + cat)),
          h("span", { class: "web-cat-score g-" + scoreClass(r.scores[cat]) }, r.scores[cat] == null ? tr("w_na") : num(r.scores[cat]) + "/100")),
        f ? h("details", { class: "web-facts-box", open: "" }, h("summary", null, tr("w_facts")), f) : null,
        h("h4", { class: "web-sub" }, tr("w_issues") + " (" + num(list.length) + ")"),
        list.length ? ul : h("p", { class: "tool-msg ok" }, tr("w_no_issues")));
    });

    var foot = h("footer", { class: "web-report-foot" },
      h("p", { class: "tool-note" }, document.querySelector("#web .tool-note") ? document.querySelector("#web .tool-note").textContent : ""),
      h("p", { class: "muted" }, tr("w_expires", { d: fmtDate(d.expires) })),
      h("p", { class: "muted web-printonly" }, ltr(shareUrl)));

    fill(out, head, top);
    sections.forEach(function (s) { out.appendChild(s); });
    out.appendChild(foot);
    out.hidden = false;
    document.body.classList.add("has-web-report");
  }

  // ---------- PDF ----------
  // The PDF is its own designed document (health-report-pdf.js), drawn page by page into a real PDF file.
  // That file and its two libraries load only when someone asks for a PDF.
  var SELF = document.currentScript && document.currentScript.src || "/assets/js/health-checker.js";
  var JS_DIR = SELF.replace(/[?#].*$/, "").replace(/[^/]*$/, "");
  var VERSION = (SELF.match(/\?v=\w+/) || [""])[0]; // the build stamp, so a new deploy isn't served from cache
  var PDF_LIBS = [JS_DIR + "../lib/jspdf-4.2.1.min.js", JS_DIR + "../lib/html2canvas-pro-2.5.2.min.js", JS_DIR + "health-report-pdf.js" + VERSION];
  var pdfLoading = null;
  function loadScript(src) {
    return new Promise(function (ok, fail) {
      var s = h("script", { src: src });
      s.onload = ok; s.onerror = function () { fail(new Error("load " + src)); };
      document.head.appendChild(s);
    });
  }
  function downloadPdf(d, btn) {
    if (btn.disabled) return;
    var label = btn.querySelector("span");
    btn.disabled = true;
    label.textContent = tr("w_pdf_making");
    if (!pdfLoading) pdfLoading = PDF_LIBS.reduce(function (p, src) { return p.then(function () { return loadScript(src); }); }, Promise.resolve());
    pdfLoading.then(function () {
      return window.webReportPdf(d, {
        tr: tr, h: h, num: num, ltr: ltr, fmtDate: fmtDate, rtl: rtl, lang: lang, CATS: CATS, FACTS: FACTS,
        issueText: issueText, ring: ring, scoreClass: scoreClass,
        shareUrl: location.origin + location.pathname + "?r=" + encodeURIComponent(d.id),
        brand: document.title.split(" | ").pop(),
        passive: document.querySelector("#web .tool-note") ? document.querySelector("#web .tool-note").textContent : "",
      });
    }).catch(function (e) {
      pdfLoading = null;
      if (window.console) console.error(e);
      alert(tr("w_pdf_fail"));
    }).then(function () { btn.disabled = false; label.textContent = tr("w_pdf"); });
  }

  // ---------- Start ----------
  if (!API) return;
  renderCaptcha();
  var shared = new URLSearchParams(location.search).get("r");
  if (shared && /^[A-Za-z0-9_-]{8,40}$/.test(shared)) {
    fill(progress, h("p", { class: "tool-msg" }, "…"));
    api("/report/" + shared).then(function (d) {
      progress.textContent = "";
      input.value = d.url;
      renderReport(d, true);
      // A shared report whose SSL test was still running: show the latest result if it finished since.
      if (d.ssl && (d.ssl.status === "pending" || d.ssl.status === "busy")) setTimeout(function () { api("/report/" + shared).then(function (x) { renderReport(x, true); }); }, 15000);
    }, function (e) { fill(progress, h("p", { class: "tool-msg bad" }, errText(e.code))); });
  }
})();
