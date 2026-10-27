// Broken link check: up to 25 of the page's own links per call (a free Worker may make 50 requests per call).
import { Budget, safeFetch, UA } from "./net.js";

export async function runLinks(links) {
  const budget = new Budget(48);
  const cache = new Map();
  const results = await Promise.all(
    links.map(async (url) => {
      try {
        let r = await safeFetch(budget, url, cache, { method: "HEAD", hops: 0, timeout: 8000, headers: { "user-agent": UA } });
        let status = r.res.status;
        r.res.body?.cancel();
        // Some servers don't support HEAD; ask again with GET.
        if ((status === 405 || status === 501 || status === 403) && budget.has(1)) {
          r = await safeFetch(budget, url, cache, { hops: 0, timeout: 8000 });
          status = r.res.status;
          r.res.body?.cancel();
        }
        return { url, status };
      } catch (e) {
        return { url, status: 0, error: e.code || (e.name === "TimeoutError" ? "timeout" : "error") };
      }
    }),
  );
  const done = results.filter((r) => r.error !== "budget" && r.error !== "blocked_private");
  return { checked: done.length, broken: done.filter((r) => r.status >= 400 || r.status === 0) };
}
