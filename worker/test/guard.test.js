// Run with: npm test (plain Node, no Cloudflare needed).
import test from "node:test";
import assert from "node:assert/strict";
import { clientKey, originAllowed, withinBurst, daySpent, markDaySpent } from "../src/guard.js";

const env = { ALLOWED_ORIGINS: "https://sanaullahniazi.com,http://localhost:4000" };

test("IPv6 visitors are counted by their /64 block, IPv4 by address", () => {
  assert.equal(clientKey("203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey("2001:db8:85a3:0042:1000:8a2e:0370:7334"), "2001:db8:85a3:42::/64");
  assert.equal(clientKey("2001:DB8:85A3:42::1"), "2001:db8:85a3:42::/64");
  assert.equal(clientKey("2001:db8:85a3:42:ffff::9"), clientKey("2001:db8:85a3:42::1"));
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKey("::1"), "0:0:0:0::/64");
  assert.equal(clientKey(""), "unknown");
  assert.equal(clientKey(null), "unknown");
});

test("only the site's own pages (or no Origin at all) may call the API", () => {
  const req = (origin) => new Request("https://api.sanaullahniazi.com/", origin ? { headers: { origin } } : {});
  assert.equal(originAllowed(req(), env), true);
  assert.equal(originAllowed(req("https://sanaullahniazi.com"), env), true);
  assert.equal(originAllowed(req("https://evil.example"), env), false);
  assert.equal(originAllowed(req("https://sanaullahniazi.com.evil.example"), env), false);
  assert.equal(originAllowed(req("null"), env), false);
});

test("burst limit uses the binding when there is one", async () => {
  assert.equal(await withinBurst({}, "k"), true);
  assert.equal(await withinBurst({ BURST: { limit: async () => ({ success: false }) } }, "k"), false);
  assert.equal(await withinBurst({ BURST: { limit: async () => ({ success: true }) } }, "k"), true);
  assert.equal(await withinBurst({ BURST: { limit: async () => { throw new Error("down"); } } }, "k"), true);
});

test("a used-up daily allowance is remembered until the day changes", () => {
  assert.equal(daySpent("test", 100), false);
  markDaySpent("test", 100);
  assert.equal(daySpent("test", 100), true);
  assert.equal(daySpent("test", 101), false);
});
