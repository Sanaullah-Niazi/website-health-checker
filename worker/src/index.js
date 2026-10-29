// Website Health & Security Checker: the backend for /tools/website-health-checker/ on sanaullahniazi.com.
//
//   POST /scan                 {url, token, lang, fresh}  checks the CAPTCHA and rate limit, returns {id, key}
//   POST /scan/:id/:part       header X-Scan-Key           runs one part: core, psi-mobile, psi-desktop, links-0, links-1, ssl
//   GET  /report/:id                                       the finished report (also the shareable link's data)
//
// It also runs the prompt injection lab (/tools/prompt-injection-lab/, the bot itself is in lab.js):
//   POST /lab/session          {token}                     checks the CAPTCHA, returns {key, runs, expires}
//   POST /lab/run              header X-Lab-Key, {text, mode, level}   one attack on the demo bot
//
// And the YouTube creator tools (/tools/youtube/, the routes are in yt.js):
//   GET  /yt/video, /yt/channel, /yt/outliers, /yt/report, /yt/suggest, /yt/categories, /yt/trending, /yt/transcript, /yt/thumb
//
// A scan is split into parts because a free Worker may make only 50 outbound requests per call.
// Reports are deleted after REPORT_DAYS by the daily cron job.
import { checkUrlShape, guardHost, Budget, codeError } from "./net.js";
import { runCore } from "./core.js";
import { runPsi } from "./psi.js";
import { runLinks } from "./links.js";
import { runSsl } from "./ssl.js";
import { buildReport } from "./report.js";
import { attack, LEVELS } from "./lab.js";
import { handleYt } from "./yt.js";

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
      if (parts[0] === "yt" && parts.length === 2) {
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        return await handleYt(request, env, ctx, parts[1], { cors, limit: () => ytLimit(env, ip) });
      }
      let body;
      if (request.method === "POST" && parts[0] === "scan" && parts.length === 1) body = await startScan(request, env);
      else if (request.method === "POST" && parts[0] === "scan" && parts.length === 3) body = await runPart(request, env, parts[1], parts[2]);
      else if (request.method === "GET" && parts[0] === "report" && parts.length === 2) body = await getReport(env, parts[1]);
      else if (request.method === "POST" && parts[0] === "lab" && parts[1] === "session" && parts.length === 2) body = await startLab(request, env);
      else if (request.method === "POST" && parts[0] === "lab" && parts[1] === "run" && parts.length === 2) body = await runLab(request, env);
      else if (request.method === "GET" && parts.length === 0) body = { ok: true, ssl: !!env.SSL_LABS_EMAIL, psi: !!env.PSI_KEY, lab: !!env.AI, yt: !!env.YT_KEY };
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

// ----- Prompt injection lab -----

// A lab session lets one visitor run LAB_RUNS attacks for an hour after a single CAPTCHA, so "Run all" doesn't ask 40 times.
// The key is signed rather than stored: <id>.<expires>.<signature>.
async function startLab(request, env) {
  if (!env.AI) throw codeError("not_configured", 503);
  const input = await readJson(request);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  await verifyTurnstile(env, input.token, ip);

  const now = Date.now();
  const hour = Math.floor(now / 3600_000);
  const ipKey = `lh:${await sha256(ip + labSecret(env))}:${hour}`;
  const r = await env.DB.prepare("INSERT INTO hits (k, n, reset) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n")
    .bind(ipKey, (hour + 1) * 3600_000).first();
  if (r.n > num(env.LAB_SESSIONS_PER_HOUR, 3)) throw codeError("rate_limited", 429);

  const payload = `${randomId(9)}.${now + 3600_000}`;
  return { key: `${payload}.${await sign(env, payload)}`, runs: num(env.LAB_RUNS, 100), expires: now + 3600_000 };
}

async function runLab(request, env) {
  if (!env.AI) throw codeError("not_configured", 503);
  const [sid, exp, sig] = (request.headers.get("x-lab-key") || "").split(".");
  if (!sid || !exp || !sig || !safeEqual(sig, await sign(env, `${sid}.${exp}`))) throw codeError("forbidden", 403);
  const now = Date.now();
  if (+exp < now) throw codeError("expired", 403);

  const input = await readJson(request);
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > 2000) throw codeError("bad_request");
  const mode = input.mode === "indirect" ? "indirect" : "direct";
  const level = LEVELS.includes(input.level) ? input.level : 0;

  // Count every run against the session, and the ones that reach the model against the free daily allowance.
  const upsert = "INSERT INTO hits (k, n, reset) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n";
  const used = await env.DB.prepare(upsert).bind(`ls:${sid}`, +exp).first();
  const runs = num(env.LAB_RUNS, 100);
  if (used.n > runs) throw codeError("session_used", 429);

  const day = Math.floor(now / 86400_000);
  const ai = {
    run: async (model, opts) => {
      const d = await env.DB.prepare(upsert).bind(`ld:${day}`, (day + 1) * 86400_000).first();
      if (d.n > num(env.LAB_RUNS_PER_DAY, 700)) throw codeError("daily_limit", 429);
      return env.AI.run(model, opts);
    },
  };
  let result;
  try {
    result = await attack({ ai, model: env.LAB_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8", text, mode, level });
  } catch (e) {
    if (e.code) throw e;
    console.error(e);
    throw codeError("model_error", 502);
  }
  return { ...result, level, mode, left: Math.max(0, runs - used.n) };
}

function labSecret(env) {
  return env.HASH_SALT || env.TURNSTILE_SECRET || "";
}

async function sign(env, payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("lab:" + labSecret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ----- Abuse protection -----

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) throw codeError("not_configured", 503);
  if (!token || typeof token !== "string" || token.length > 2048) throw codeError("captcha", 403);
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", ip);
  // One retry: a network hiccup here would otherwise fail the scan with a bare server error.
  const verify = () => fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form, signal: AbortSignal.timeout(8000) });
  const r = await verify().catch(() => verify());
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

// The YouTube tools: lookups per visitor per hour, and for everyone per day (keeps inside the free API quota).
async function ytLimit(env, ip) {
  const now = Date.now();
  const hour = Math.floor(now / 3600_000);
  const day = Math.floor(now / 86400_000);
  const ipKey = `yh:${await sha256(ip + (env.HASH_SALT || env.TURNSTILE_SECRET || ""))}:${hour}`;
  const upsert = "INSERT INTO hits (k, n, reset) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n";
  const [a, b] = await env.DB.batch([
    env.DB.prepare(upsert).bind(ipKey, (hour + 1) * 3600_000),
    env.DB.prepare(upsert).bind(`yd:${day}`, (day + 1) * 86400_000),
  ]);
  if (a.results[0].n > num(env.YT_PER_HOUR, 60)) throw codeError("rate_limited", 429);
  if (b.results[0].n > num(env.YT_PER_DAY, 3000)) throw codeError("daily_limit", 429);
}

// ----- Helpers -----

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-scan-key, x-lab-key",
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
