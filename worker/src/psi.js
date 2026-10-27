// Google PageSpeed Insights (Lighthouse run by Google). Free with an API key: 25,000 runs a day.
// `fields` trims the answer from several MB to what the report uses, which keeps the Worker inside its CPU limit.

const FIELDS = [
  "loadingExperience(metrics,overall_category)",
  "originLoadingExperience(metrics,overall_category)",
  "lighthouseResult(finalUrl,runWarnings,runtimeError,categories/*(score,auditRefs(id,weight,group)),audits/*(id,title,description,score,scoreDisplayMode,numericValue,displayValue,metricSavings,details(type,overallSavingsMs,data)))",
].join(",");

const LOCALES = { en: "en", ur: "ur", de: "de", zh: "zh-CN" };
const DESIGN_AUDITS = ["color-contrast", "font-size", "tap-targets", "target-size", "viewport", "image-aspect-ratio", "image-size-responsive", "font-display"];

export async function runPsi(env, url, strategy, lang) {
  if (!env.PSI_KEY) return { error: "no_key" };
  const params = new URLSearchParams({ url, strategy, key: env.PSI_KEY, locale: LOCALES[lang] || "en" });
  for (const c of ["performance", "accessibility", "best-practices", "seo"]) params.append("category", c);
  const base = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`;
  let res = await fetch(`${base}&fields=${encodeURIComponent(FIELDS)}`, { signal: AbortSignal.timeout(90000) });
  if (res.status === 400) {
    // If Google ever rejects the field list, fall back to the full answer rather than failing.
    const body = await res.text();
    if (/fields|Invalid field selection/i.test(body)) res = await fetch(base, { signal: AbortSignal.timeout(90000) });
    else return { error: psiError(body) };
  }
  if (!res.ok) return { error: psiError(await res.text().catch(() => "")) };
  let j = await res.json();
  // Same fallback if the trimmed answer came back without the parts we need.
  if (!j.lighthouseResult?.categories || !Object.keys(j.lighthouseResult.audits || {}).length) {
    const full = await fetch(base, { signal: AbortSignal.timeout(90000) });
    if (!full.ok) return { error: psiError(await full.text().catch(() => "")) };
    j = await full.json();
  }
  const lh = j.lighthouseResult;
  if (!lh || lh.runtimeError?.code) return { error: "lighthouse", detail: lh?.runtimeError?.code || null };
  return summarise(j, lh);
}

function psiError(body) {
  if (/FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|NO_FCP|unable to reach/i.test(body)) return "unreachable";
  if (/quota|rateLimit|RESOURCE_EXHAUSTED/i.test(body)) return "quota";
  return "failed";
}

function summarise(j, lh) {
  const a = lh.audits || {};
  const cat = (id) => (lh.categories?.[id]?.score == null ? null : Math.round(lh.categories[id].score * 100));
  const num = (id) => a[id]?.numericValue ?? null;
  const field = (src) => {
    if (!src?.metrics) return null;
    const m = src.metrics;
    const pick = (k) => (m[k] ? { p75: m[k].percentile, cat: m[k].category } : null);
    return {
      lcp: pick("LARGEST_CONTENTFUL_PAINT_MS"),
      cls: m.CUMULATIVE_LAYOUT_SHIFT_SCORE ? { p75: m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100, cat: m.CUMULATIVE_LAYOUT_SHIFT_SCORE.category } : null,
      inp: pick("INTERACTION_TO_NEXT_PAINT"),
      fcp: pick("FIRST_CONTENTFUL_PAINT_MS"),
      ttfb: pick("EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
      overall: src.overall_category || null,
    };
  };
  // Failing audits of a category, heaviest first.
  const failing = (catId, limit) => {
    const refs = lh.categories?.[catId]?.auditRefs || [];
    return refs
      .filter((r) => a[r.id] && a[r.id].scoreDisplayMode !== "notApplicable" && a[r.id].scoreDisplayMode !== "manual" && a[r.id].scoreDisplayMode !== "informative" && a[r.id].score !== null && a[r.id].score < 0.9 && r.group !== "metrics")
      .sort((x, y) => (y.weight || 0) - (x.weight || 0) || a[x.id].score - a[y.id].score)
      .slice(0, limit)
      .map((r) => audit(a[r.id], r.weight));
  };
  // Older Lighthouse versions mark these as "opportunity" audits; newer ones as insights with metricSavings.
  const savings = (x) => x.details?.overallSavingsMs || Math.max(x.metricSavings?.LCP || 0, x.metricSavings?.FCP || 0);
  const opportunities = Object.values(a)
    .filter((x) => (x.details?.type === "opportunity" || x.metricSavings) && x.score !== null && x.score < 0.9 && savings(x) >= 100)
    .sort((x, y) => savings(y) - savings(x))
    .slice(0, 6)
    .map((x) => ({ ...audit(x), savingsMs: Math.round(savings(x)) }));

  return {
    finalUrl: lh.finalUrl,
    scores: { performance: cat("performance"), accessibility: cat("accessibility"), bestPractices: cat("best-practices"), seo: cat("seo") },
    lab: {
      lcp: num("largest-contentful-paint"), cls: num("cumulative-layout-shift"), tbt: num("total-blocking-time"),
      fcp: num("first-contentful-paint"), si: num("speed-index"),
    },
    field: field(j.loadingExperience) || null,
    originField: field(j.originLoadingExperience) || null,
    opportunities,
    a11y: failing("accessibility", 10),
    bestPractices: failing("best-practices", 8),
    seo: failing("seo", 8),
    design: DESIGN_AUDITS.filter((id) => a[id] && a[id].score !== null && a[id].score < 0.9 && a[id].scoreDisplayMode !== "notApplicable").map((id) => audit(a[id])),
    screenshot: a["final-screenshot"]?.details?.data || null,
  };
}

function audit(x, weight) {
  return {
    id: x.id,
    title: String(x.title || "").slice(0, 200),
    description: String(x.description || "").slice(0, 600),
    display: x.displayValue ? String(x.displayValue).slice(0, 80) : null,
    score: x.score,
    weight: weight ?? null,
  };
}
