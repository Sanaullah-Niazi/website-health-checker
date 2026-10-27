// Qualys SSL Labs API v4: certificate, TLS protocols and the A+ to F grade.
// Turned on only when SSL_LABS_EMAIL (an email registered with SSL Labs) is set. A fresh assessment takes
// one to two minutes, so the page asks again every 10 seconds until it's ready; cached results come back at once.
// SSL Labs' own copy is reused for at most 1 hour (maxAge), the same as a whole scan (CACHE_HOURS), so a fresh scan
// after a TLS change shows the new grade.

export async function runSsl(env, host) {
  if (!env.SSL_LABS_EMAIL) return { status: "off" };
  const url = `https://api.ssllabs.com/api/v4/analyze?host=${encodeURIComponent(host)}&fromCache=on&maxAge=1&all=done`;
  const res = await fetch(url, { headers: { email: env.SSL_LABS_EMAIL }, signal: AbortSignal.timeout(20000) });
  if (res.status === 429 || res.status === 529 || res.status === 503) return { status: "busy" };
  if (res.status === 441) return { status: "error", error: "not_registered" };
  if (!res.ok) return { status: "error", error: `http_${res.status}` };
  const j = await res.json();
  if (j.status === "ERROR") return { status: "error", error: String(j.statusMessage || "error").slice(0, 120) };
  if (j.status !== "READY") return { status: "pending", progress: Math.max(0, ...(j.endpoints || []).map((e) => e.progress || 0)) };

  const ends = (j.endpoints || []).filter((e) => e.grade);
  const order = ["A+", "A", "A-", "B", "C", "D", "E", "F", "T", "M"];
  const worst = ends.map((e) => e.grade).sort((x, y) => order.indexOf(y) - order.indexOf(x))[0] || null;
  const d = ends[0]?.details || {};
  const certIds = d.certChains?.[0]?.certIds || [];
  const leaf = (j.certs || []).find((c) => c.id === certIds[0]) || (j.certs || [])[0];
  return {
    status: "ready",
    grade: worst,
    gradeTrustIgnored: ends[0]?.gradeTrustIgnored || null,
    endpoints: ends.length,
    protocols: (d.protocols || []).map((p) => `${p.name} ${p.version}`),
    cert: leaf
      ? {
          subject: String(leaf.subject || "").slice(0, 200),
          issuer: String(leaf.issuerSubject || "").replace(/^.*?CN=([^,]+).*$/, "$1").slice(0, 120),
          notAfter: leaf.notAfter || null,
          names: (leaf.altNames || []).slice(0, 10),
          keyAlg: leaf.keyAlg || null,
          keySize: leaf.keySize || null,
        }
      : null,
    chainIssues: d.certChains?.[0]?.issues || 0,
    forwardSecrecy: d.forwardSecrecy ?? null,
    heartbleed: !!d.heartbleed,
    poodle: !!d.poodle,
    vulnBeast: !!d.vulnBeast,
    warnings: ends.some((e) => e.hasWarnings),
  };
}
