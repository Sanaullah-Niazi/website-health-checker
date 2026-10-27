// Network helpers: DNS over HTTPS, the private-address guard, and a fetch that checks every redirect hop.
// A free Worker may make 50 outbound requests per invocation, so every call goes through a Budget.

export const UA = "Mozilla/5.0 (compatible; SanaullahNiaziHealthCheck/1.0; +https://sanaullahniazi.com/tools/website-health-checker/)";

export class Budget {
  constructor(max = 46) { this.left = max; }
  take(n = 1) {
    if (this.left < n) throw codeError("budget", 500);
    this.left -= n;
  }
  has(n = 1) { return this.left >= n; }
}

export async function doh(budget, name, type) {
  budget.take();
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error("dns");
  const j = await res.json();
  return { status: j.Status, answers: j.Answer || [] };
}

// Returns the TXT records of a name as plain strings (quoted chunks joined).
export async function txt(budget, name) {
  const r = await doh(budget, name, "TXT");
  return r.answers.filter((a) => a.type === 16).map((a) => a.data.replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
}

function v4ToInt(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const V4_BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([a, bits]) => [v4ToInt(a), bits]);

export function isPrivateV4(ip) {
  const n = v4ToInt(ip);
  if (n === null) return true;
  return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
}

function expandV6(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]);
    if (n === null) return null;
    s = s.slice(0, -v4[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...Array(fill).fill("0"), ...tail];
  if (parts.length !== 8) return null;
  const nums = parts.map((h) => parseInt(h, 16));
  return nums.some((n) => !(n >= 0 && n <= 0xffff)) ? null : nums;
}

export function isPrivateV6(ip) {
  const p = expandV6(ip);
  if (!p) return true;
  const embedded = () => `${p[6] >> 8}.${p[6] & 255}.${p[7] >> 8}.${p[7] & 255}`;
  if (p.every((n) => n === 0)) return true; // ::
  if (p.slice(0, 7).every((n) => n === 0) && p[7] === 1) return true; // ::1
  if ((p[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((p[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((p[0] & 0xff00) === 0xff00) return true; // multicast
  if (p[0] === 0x2001 && p[1] === 0x0db8) return true; // documentation
  if (p[0] === 0x0100 && p[1] === 0 && p[2] === 0 && p[3] === 0) return true; // discard
  if (p.slice(0, 5).every((n) => n === 0) && p[5] === 0xffff) return isPrivateV4(embedded()); // ::ffff:a.b.c.d
  if (p[0] === 0x64 && p[1] === 0xff9b) return isPrivateV4(embedded()); // NAT64
  if (p[0] === 0x2002) return isPrivateV4(`${p[1] >> 8}.${p[1] & 255}.${p[2] >> 8}.${p[2] & 255}`); // 6to4
  return false;
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa", ".test", ".invalid", ".example", ".onion"];

// Throws a coded error if the URL may not be scanned. Returns the parsed URL.
export function checkUrlShape(raw) {
  let input = String(raw || "").trim();
  if (!input) throw codeError("bad_url");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = "https://" + input;
  let u;
  try { u = new URL(input); } catch { throw codeError("bad_url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw codeError("bad_url");
  if (u.username || u.password) throw codeError("bad_url");
  if (u.port && u.port !== "80" && u.port !== "443") throw codeError("blocked_port");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length > 253) throw codeError("bad_url");
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const priv = host.startsWith("[") ? isPrivateV6(host) : isPrivateV4(host);
    if (priv) throw codeError("blocked_private");
    return u;
  }
  // The URL parser already turns 0x7f.1 or 2130706433 into 127.0.0.1; anything else ending in a number isn't a real domain.
  if (/^(0x[0-9a-f]*|\d+)$/i.test(host.split(".").pop())) throw codeError("blocked_private");
  if (!host.includes(".") || host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw codeError("blocked_private");
  u.hash = "";
  return u;
}

export function codeError(code, status = 400) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  return e;
}

// Resolves a host and makes sure every address it points to is public. Results (promises, so parallel
// calls share one lookup) are cached per request.
export async function guardHost(budget, host, cache) {
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!cache.has(host)) cache.set(host, verdictFor(budget, host));
  const verdict = await cache.get(host);
  if (verdict !== true) throw codeError(verdict);
}

async function verdictFor(budget, host) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateV4(host) ? "blocked_private" : true;
  if (host.includes(":")) return isPrivateV6(host) ? "blocked_private" : true;
  try {
    const [a, aaaa] = await Promise.all([doh(budget, host, "A"), doh(budget, host, "AAAA")]);
    const v4 = a.answers.filter((x) => x.type === 1).map((x) => x.data);
    const v6 = aaaa.answers.filter((x) => x.type === 28).map((x) => x.data);
    if (!v4.length && !v6.length) return "no_dns";
    if (v4.some(isPrivateV4) || v6.some(isPrivateV6)) return "blocked_private";
    return true;
  } catch (e) {
    return e.code === "budget" ? "budget" : "no_dns";
  }
}

// fetch() that follows up to `hops` redirects by hand, checking each new host first.
export async function safeFetch(budget, url, cache, { method = "GET", hops = 5, timeout = 12000, headers = {} } = {}) {
  const chain = [];
  let current = new URL(url);
  for (let i = 0; i <= hops; i++) {
    checkUrlShape(current.href);
    await guardHost(budget, current.hostname, cache);
    budget.take();
    const started = Date.now();
    const res = await fetch(current.href, {
      method,
      redirect: "manual",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "en", ...headers },
      signal: AbortSignal.timeout(timeout),
    });
    const ms = Date.now() - started;
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc && i < hops) {
      chain.push({ url: current.href, status: res.status, ms, headers: res.headers });
      res.body?.cancel();
      current = new URL(loc, current);
      continue;
    }
    return { res, url: current.href, chain, ms };
  }
  throw codeError("too_many_redirects");
}

// Reads at most `max` bytes of a response as text.
export async function readText(res, max = 2_000_000) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.byteLength, all.length - off));
    all.set(part, off);
    off += part.byteLength;
    if (off >= all.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

// Rough registrable domain without the full public suffix list: enough to find the domain that holds SPF/DMARC.
const TWO_LEVEL = /\.(co|com|net|org|gov|edu|ac|or|ne|go|gob|nic|ltd|plc|sch|mil|biz|info)\.[a-z]{2}$/;
export function baseDomain(host) {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const keep = TWO_LEVEL.test(host) ? 3 : 2;
  return parts.slice(-keep).join(".");
}
