// Run with: npm test (plain Node, no Cloudflare needed).
import test from "node:test";
import assert from "node:assert/strict";
import { checkUrlShape, isPrivateV4, isPrivateV6, baseDomain } from "../src/net.js";
import { buildReport } from "../src/report.js";

test("private and reserved addresses are refused", () => {
  for (const u of ["http://127.0.0.1", "https://10.1.2.3/", "http://192.168.0.10", "http://169.254.169.254/latest", "https://[::1]/",
    "https://[fd00::1]/", "https://[::ffff:10.0.0.1]/", "http://0x7f.1/", "http://2130706433/", "http://localhost/", "http://printer.local/", "http://intranet/"]) {
    assert.throws(() => checkUrlShape(u), /blocked_private/, u);
  }
});

test("odd ports, schemes and credentials are refused", () => {
  assert.throws(() => checkUrlShape("https://example.com:8443/"), /blocked_port/);
  assert.throws(() => checkUrlShape("ftp://example.com/"), /bad_url/);
  assert.throws(() => checkUrlShape("https://user:pw@example.com/"), /bad_url/);
});

test("normal addresses pass and get https:// added", () => {
  assert.equal(checkUrlShape("example.com").href, "https://example.com/");
  assert.equal(checkUrlShape("http://3d.cafe/a#b").href, "http://3d.cafe/a");
  assert.equal(checkUrlShape("https://93.184.215.14/").hostname, "93.184.215.14");
});

test("IP range helpers", () => {
  assert.ok(isPrivateV4("100.64.1.1"));
  assert.ok(!isPrivateV4("8.8.8.8"));
  assert.ok(isPrivateV6("fe80::1"));
  assert.ok(!isPrivateV6("2606:4700::1111"));
  assert.ok(isPrivateV6("64:ff9b::a00:1"));
});

test("base domain", () => {
  assert.equal(baseDomain("www.shop.example.com"), "example.com");
  assert.equal(baseDomain("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(baseDomain("example.com.pk"), "example.com.pk");
});

test("report scores and grade", () => {
  const core = {
    https: true, httpRedirect: "https", status: 200, ms: 200, bytes: 1000, cookies: [],
    headers: { "strict-transport-security": "max-age=31536000", "content-security-policy": "default-src 'self'; frame-ancestors 'self'", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "permissions-policy": "camera=()" },
    html: { lang: "en", title: "A good title for this page", description: "x".repeat(130), viewport: "width=device-width, initial-scale=1", canonical: "/", favicon: true,
      headings: [{ level: 1, text: "Hi" }], og: { title: "a", description: "b", image: "c" }, jsonld: ["Person"], jsonldInvalid: 0, images: 1, noAlt: 0,
      mixedActive: [], mixedPassive: [], insecureForms: 0, noSri: 0 },
    securityTxt: { found: true }, robots: { found: true }, sitemap: { found: true, valid: true },
    dns: { domain: "example.com", spf: "v=spf1 -all", spfCount: 1, spfAll: "-", dmarc: "v=DMARC1; p=reject", dmarcPolicy: "reject", mx: false, dkim: [] },
    libs: [], tech: [],
  };
  const r = buildReport({ core, psiMobile: null, psiDesktop: null, links: [], ssl: null });
  assert.equal(r.issues.length, 0);
  assert.equal(r.grade, "A");
  const bad = buildReport({ core: { ...core, https: false, headers: {} }, links: [] });
  assert.ok(bad.scores.security < 50);
  assert.equal(bad.issues[0].code, "no_https");
});
