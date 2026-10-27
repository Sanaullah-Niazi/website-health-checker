// Website Health & Security Checker: the backend for /tools/website-health-checker/ on sanaullahniazi.com.
//
//   POST /scan                 {url, token, lang, fresh}  checks the CAPTCHA and rate limit, returns {id, key}
//   POST /scan/:id/:part       header X-Scan-Key           runs one part: core, psi-mobile, psi-desktop, links-0, links-1, ssl
//   GET  /report/:id                                       the finished report (also the shareable link's data)
//
// A scan is split into parts because a free Worker may make only 50 outbound requests per call.
// Reports are deleted after REPORT_DAYS by the daily cron job.
import { checkUrlShape, guardHost, Budget, codeError } from "./net.js";
import { runCore } from "./core.js";
import { runPsi } from "./psi.js";
import { runLinks } from "./links.js";
import { runSsl } from "./ssl.js";
import { buildReport } from "./report.js";

const PARTS = {
  core: "core",
  "psi-mobile": "psi_mobile",
  "psi-desktop": "psi_desktop",
  "links-0": "links0",
  "links-1": "links1",
  ssl: "ssl",
};
const LINKS_PER_PART = 25;
const MAX_SSL_POLLS = 30;

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      let body;
      if (request.method === "POST" && parts[0] === "scan" && parts.length === 1) body = await startScan(request, env);
      else if (request.method === "POST" && parts[0] === "scan" && parts.length === 3) body = await runPart(request, env, parts[1], parts[2]);
      else if (request.method === "GET" && parts[0] === "report" && parts.length === 2) body = await getReport(env, parts[1]);
      else if (request.method === "GET" && parts.length === 0) body = { ok: true, ssl: !!env.SSL_LABS_EMAIL, psi: !!env.PSI_KEY };
      else throw codeError("not_found", 404);
      return json(body, 200, cors);
    } catch (e) {
      const code = e.code || "server_error";
      if (!e.code) console.error(e);
      return json({ error: code }, e.status || 500, cors);
    }
  },

  async scheduled(event, env) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM scans WHERE expires < ?").bind(now),
      env.DB.prepare("DELETE FROM hits WHERE reset < ?").bind(now),
    ]);
  },
};

async function startScan(request, env) {
  const input = await readJson(request);
  const lang = ["en", "ur", "de", "zh"].includes(input.lang) ? input.lang : "en";
  const ip = request.headers.get("cf-connecting-ip") || "unknown";

  await verifyTurnstile(env, input.token, ip);

  // Normalise the address and refuse private, internal and odd targets before anything is fetched.
  const u = checkUrlShape(input.url);
  await guardHost(new Budget(4), u.hostname, new Map());
  const target = u.href;

  const now = Date.now();
  const cacheMs = num(env.CACHE_HOURS, 1) * 3600_000;
  if (!input.fresh) {
    const hit = await env.DB.prepare(
      "SELECT id, key FROM scans WHERE url = ? AND created > ? AND core IS NOT NULL AND psi_mobile IS NOT NULL ORDER BY created DESC LIMIT 1",
    ).bind(target, now - cacheMs).first();
    if (hit) return { id: hit.id, key: hit.key, cached: true };
  }

  await rateLimit(env, ip, now);

  const id = randomId(12);
  const key = randomId(18);
  const expires = now + num(env.REPORT_DAYS, 7) * 86400_000;
  await env.DB.prepare("INSERT INTO scans (id, key, url, host, lang, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, key, target, u.hostname, lang, now, expires).run();
  return { id, key, cached: false, ssl: !!env.SSL_LABS_EMAIL };
}

async function runPart(request, env, id, part) {
  const col = PARTS[part];
  if (!col) throw codeError("not_found", 404);
  const row = await env.DB.prepare(`SELECT key, url, host, lang, expires, core, ssl_polls, ${col} AS done FROM scans WHERE id = ?`).bind(id).first();
  if (!row || row.expires < Date.now()) throw codeError("not_found", 404);
  if (!safeEqual(request.headers.get("x-scan-key") || "", row.key)) throw codeError("forbidden", 403);

  // Each part runs once; asking again returns the saved result (except SSL Labs, which is polled until ready).
  if (row.done && part !== "ssl") return { part, ...brief(part, JSON.parse(row.done)) };
  if (row.done && part === "ssl") {
    const prev = JSON.parse(row.done);
    if (prev.status !== "pending" && prev.status !== "busy") return { part, ...brief(part, prev) };
  }

  let result;
  let extra = "";
  const binds = [];
  if (part === "core") {
    try { result = await runCore(row.url); }
    catch (e) { result = { error: e.code || (e.name === "TimeoutError" ? "timeout" : "unreachable") }; }
  } else if (part === "psi-mobile" || part === "psi-desktop") {
    const strategy = part === "psi-mobile" ? "mobile" : "desktop";
    try { result = await runPsi(env, row.url, strategy, row.lang); }
    catch (e) { result = { error: e.name === "TimeoutError" ? "timeout" : "failed" }; }
    // Screenshots are kept apart so the report data stays small.
    extra = `, shot_${strategy} = ?`;
    binds.push(result.screenshot || null);
    delete result.screenshot;
  } else if (part.startsWith("links-")) {
    if (!row.core) throw codeError("core_first", 409);
    const core = JSON.parse(row.core);
    const all = core.html?.links || [];
    const n = +part.slice(6);
    result = await runLinks(all.slice(n * LINKS_PER_PART, (n + 1) * LINKS_PER_PART));
  } else if (part === "ssl") {
    if ((row.ssl_polls || 0) >= MAX_SSL_POLLS) result = { status: "error", error: "timeout" };
    else {
      try { result = await runSsl(env, row.host); }
      catch { result = { status: "busy" }; }
    }
    extra = ", ssl_polls = ssl_polls + 1";
  }
  await env.DB.prepare(`UPDATE scans SET ${col} = ?${extra} WHERE id = ?`).bind(JSON.stringify(result), ...binds, id).run();
  return { part, ...brief(part, result) };
}

// What the page needs to know right after a part finishes (the full data comes with the report).
function brief(part, r) {
  if (part === "core") return { ok: !r.error, error: r.error, links: r.html?.links?.length || 0 };
  if (part === "ssl") return { ok: r.status === "ready", status: r.status, progress: r.progress, error: r.error };
  return { ok: !r.error, error: r.error };
}

async function getReport(env, id) {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) throw codeError("not_found", 404);
  const row = await env.DB.prepare("SELECT * FROM scans WHERE id = ?").bind(id).first();
  if (!row || row.expires < Date.now()) throw codeError("not_found", 404);
  const parse = (s) => (s ? JSON.parse(s) : null);
  const core = parse(row.core);
  const psiMobile = parse(row.psi_mobile);
  const psiDesktop = parse(row.psi_desktop);
  const links = [parse(row.links0), parse(row.links1)];
  const ssl = parse(row.ssl);
  const report = buildReport({ core, psiMobile, psiDesktop, links: links.filter(Boolean), ssl });
  if (core?.html) core.html.linkCount = core.html.links.length;
  if (core?.html) delete core.html.links;
  return {
    id: row.id,
    url: row.url,
    host: row.host,
    created: row.created,
    expires: row.expires,
    report,
    core,
    psi: { mobile: psiMobile, desktop: psiDesktop },
    links: links.filter(Boolean),
    ssl,
    shots: { mobile: row.shot_mobile || null, desktop: row.shot_desktop || null },
  };
}

// ----- Abuse protection -----

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) throw codeError("not_configured", 503);
  if (!token || typeof token !== "string" || token.length > 2048) throw codeError("captcha", 403);
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw codeError("captcha", 403);
}

async function rateLimit(env, ip, now) {
  const hour = Math.floor(now / 3600_000);
  const day = Math.floor(now / 86400_000);
  const ipKey = `h:${await sha256(ip + (env.HASH_SALT || env.TURNSTILE_SECRET))}:${hour}`;
  const dayKey = `d:${day}`;
  const upsert = "INSERT INTO hits (k, n, reset) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n";
  const [a, b] = await env.DB.batch([
    env.DB.prepare(upsert).bind(ipKey, (hour + 1) * 3600_000),
    env.DB.prepare(upsert).bind(dayKey, (day + 1) * 86400_000),
  ]);
  if (a.results[0].n > num(env.SCANS_PER_HOUR, 5)) throw codeError("rate_limited", 429);
  if (b.results[0].n > num(env.SCANS_PER_DAY, 300)) throw codeError("daily_limit", 429);
}

// ----- Helpers -----

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-scan-key",
    "access-control-max-age": "86400",
    vary: "origin",
  };
  if (allowed.includes(origin)) h["access-control-allow-origin"] = origin;
  return h;
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 10_000) throw codeError("bad_request");
  try { return JSON.parse(text); } catch { throw codeError("bad_request"); }
}

function randomId(bytes) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}
