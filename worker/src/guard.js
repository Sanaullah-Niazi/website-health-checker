// Abuse protection that runs before any other work, so a flood costs as little as possible.
//
// 1. Requests sent by a browser from another website are refused. Pages elsewhere could otherwise make their visitors'
//    browsers call this API in the background and use up the free daily allowances. (Visitors to sanaullahniazi.com,
//    and scripts that send no Origin, are unaffected; scripts still meet the per-visitor limits below.)
// 2. A short burst limit per visitor, kept in Cloudflare's memory (the BURST binding in wrangler.toml), so a script
//    hammering the API is turned away without a database write for every request.
// 3. Visitors are counted by IPv4 address, or by the /64 block for IPv6: one home or server is normally given a whole
//    /64, billions of addresses, so counting single IPv6 addresses would let one person pose as many.

export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// True when the request didn't come from a page on another website.
export function originAllowed(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return allowedOrigins(env).includes(origin);
}

// The address the rate limits count: the IPv4 address, or the first 64 bits of an IPv6 address.
export function clientKey(ip) {
  ip = String(ip || "").trim().toLowerCase();
  if (!ip.includes(":")) return ip || "unknown";
  const halves = ip.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export function clientIp(request) {
  return clientKey(request.headers.get("cf-connecting-ip"));
}

// Burst limit. Returns false when the visitor is over it. Without the binding (local tests) everything passes.
export async function withinBurst(env, key) {
  if (!env.BURST?.limit) return true;
  try {
    const { success } = await env.BURST.limit({ key });
    return success;
  } catch {
    return true;
  }
}

// Once a daily allowance is used up, this copy of the Worker remembers it until the day ends, so later requests are
// refused without another database write.
const spent = new Map();
export function daySpent(name, day) {
  return spent.get(name) === day;
}
export function markDaySpent(name, day) {
  spent.set(name, day);
}
