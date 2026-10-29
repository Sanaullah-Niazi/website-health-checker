// YouTube creator tools (/tools/youtube/ on sanaullahniazi.com). Every route is a GET, so answers can be cached.
//
//   GET /yt/video?v=<link or id>&hl=en                 title, tags, category and numbers of one video
//   GET /yt/channel?c=<link, @handle or id>&hl=en      channel details, its own keywords and the tags its latest uploads use
//   GET /yt/outliers?c=<link, @handle or id>           the latest 100 uploads, each scored against the channel's median views
//   GET /yt/report?c=<link, @handle or id>&p=90        a channel health report for the last 30, 90 or 365 days, or p=all
//   GET /yt/suggest?q=<keyword>&hl=en&gl=US            keyword ideas from YouTube search's autocomplete
//   GET /yt/categories?gl=US&hl=en                     the video categories of a country
//   GET /yt/trending?gl=US&cat=<id>&hl=en              the tags most used by the trending videos of a category
//   GET /yt/transcript?v=<link or id>&lang=<code>      the captions of a video, as lines with times
//   GET /yt/thumb?v=<id>&q=maxres                      a thumbnail as a download (needs no API key)
//
// Video, channel, category and trending data come from the official YouTube Data API v3 (secret YT_KEY, 10,000 quota
// units a day for free; each lookup costs 1 to 5 units, a health report up to 13). Keyword ideas use the public autocomplete that YouTube's own
// search box uses, and captions use the same caption track the YouTube player loads, so those two can stop working if
// YouTube changes them (set YT_TRANSCRIPTS = "off" in wrangler.toml to turn the transcript route off).
// Nothing a visitor looks up is stored. Videos themselves are never downloaded: that breaks YouTube's terms.

const API = "https://www.googleapis.com/youtube/v3/";
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_RE = /^UC[A-Za-z0-9_-]{22}$/;
const THUMBS = { maxres: "maxresdefault", sd: "sddefault", hq: "hqdefault", mq: "mqdefault", default: "default" };
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const REGION_RE = /^[A-Z]{2}$/;

export function ytError(code, status = 400) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  return e;
}

// ----- Reading what people paste -----

// A video id from a link (watch, youtu.be, shorts, embed, live, music, mobile) or the id on its own.
export function videoId(input) {
  const s = String(input || "").trim();
  if (ID_RE.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") return pick(u.pathname.split("/")[1]);
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  if (u.searchParams.get("v")) return pick(u.searchParams.get("v"));
  const m = u.pathname.match(/^\/(?:shorts|embed|live|v|e)\/([^/?#]+)/);
  return m ? pick(m[1]) : null;
}
function pick(id) { return id && ID_RE.test(id) ? id : null; }

// What a channel link points at: {id}, {handle}, {user}, or {video} when it's a video link instead.
export function channelRef(input) {
  const s = String(input || "").trim();
  if (!s || s.length > 300) return null;
  if (CHANNEL_RE.test(s)) return { id: s };
  if (/^@[\w.\-·]{3,100}$/u.test(s)) return { handle: s };
  if (!/[/.]/.test(s) && /^[\p{L}\p{N}_.\-]{3,100}$/u.test(s)) return { handle: "@" + s };
  const v = videoId(s);
  if (v) return { video: v };
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  if (host !== "youtube.com") return null;
  const parts = u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  if (!parts.length) return null;
  if (parts[0].startsWith("@")) return { handle: parts[0] };
  if (parts[0] === "channel" && CHANNEL_RE.test(parts[1] || "")) return { id: parts[1] };
  if (parts[0] === "user" && parts[1]) return { user: parts[1] };
  // Old custom addresses (/c/name) can only be looked up with a 100-unit search, but most now match the handle.
  if (parts[0] === "c" && parts[1]) return { handle: "@" + parts[1] };
  return null;
}

function langOf(v) { return LANG_RE.test(v || "") ? v : "en"; }
function regionOf(v) { const r = String(v || "").toUpperCase(); return REGION_RE.test(r) ? r : "US"; }

// ----- Turning API answers into what the page shows -----

// ISO 8601 duration (PT1H2M3S) to seconds.
export function seconds(iso) {
  const m = String(iso || "").match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

// The channel keywords field is one string: words separated by spaces, phrases in double quotes.
export function splitKeywords(s) {
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || "")))) {
    const k = (m[1] || m[2]).trim();
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

// #hashtags written in a description (YouTube shows the first three above the title).
export function hashtags(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/(?:^|[\s(])#([\p{L}\p{N}_]{2,60})/gu)) {
    const t = "#" + m[1];
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

// How often each tag is used across a set of videos, most used first.
export function tagCounts(videos, limit = 60) {
  const seen = new Map();
  for (const v of videos) {
    // Each tag counts once per video, whatever its capitals.
    const tags = new Map((v.snippet?.tags || []).map((t) => t.trim()).filter(Boolean).reverse().map((t) => [t.toLowerCase(), t]));
    for (const [k, t] of tags) {
      const e = seen.get(k) || { tag: t, n: 0 };
      e.n++;
      seen.set(k, e);
    }
  }
  return [...seen.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).slice(0, limit);
}

// Wikipedia links in topicDetails to readable names.
export function topics(urls) {
  return [...new Set((urls || []).map((u) => decodeURIComponent(String(u).split("/wiki/")[1] || "").replace(/_/g, " ")).filter(Boolean))];
}

function bestThumb(t) {
  return (t?.maxres || t?.standard || t?.high || t?.medium || t?.default || {}).url || null;
}

function videoCard(v) {
  return {
    id: v.id,
    title: v.snippet?.title || "",
    channel: v.snippet?.channelTitle || "",
    published: v.snippet?.publishedAt || null,
    views: v.statistics?.viewCount != null ? +v.statistics.viewCount : null,
    thumb: v.snippet?.thumbnails?.medium?.url || null,
  };
}

// ----- Talking to the YouTube Data API -----

async function api(env, path, params) {
  if (!env.YT_KEY) throw ytError("not_configured", 503);
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, v);
  u.searchParams.set("key", env.YT_KEY);
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = j.error?.errors?.[0]?.reason || "";
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") throw ytError("quota", 429);
    if (reason === "chartNotFound" || reason === "videoChartNotFound") throw ytError("no_chart", 404);
    if (r.status === 404) throw ytError("not_found", 404);
    console.error("youtube api", path, r.status, reason);
    throw ytError("upstream", 502);
  }
  return j;
}

async function categoryName(env, id, hl) {
  if (!id) return null;
  const j = await api(env, "videoCategories", { part: "snippet", id, hl }).catch(() => null);
  return j?.items?.[0]?.snippet?.title || null;
}

export async function getVideo(env, q) {
  const id = videoId(q.get("v"));
  if (!id) throw ytError("bad_video");
  const hl = langOf(q.get("hl"));
  const j = await api(env, "videos", { part: "snippet,statistics,contentDetails", id, hl });
  const v = j.items?.[0];
  if (!v) throw ytError("not_found", 404);
  const s = v.snippet || {};
  const tags = s.tags || [];
  return {
    id,
    title: s.localized?.title || s.title || "",
    channel: s.channelTitle || "",
    channelId: s.channelId || "",
    published: s.publishedAt || null,
    description: s.description || "",
    tags,
    tagChars: tags.reduce((n, t) => n + t.length + (t.includes(" ") ? 2 : 0), 0) + Math.max(0, tags.length - 1),
    hashtags: hashtags(s.description),
    category: await categoryName(env, s.categoryId, hl),
    language: s.defaultAudioLanguage || s.defaultLanguage || null,
    duration: seconds(v.contentDetails?.duration),
    captions: v.contentDetails?.caption === "true",
    views: v.statistics?.viewCount != null ? +v.statistics.viewCount : null,
    likes: v.statistics?.likeCount != null ? +v.statistics.likeCount : null,
    comments: v.statistics?.commentCount != null ? +v.statistics.commentCount : null,
    thumb: bestThumb(s.thumbnails),
  };
}

// The channel a link, handle, id or video points at (1 or 2 units).
async function findChannel(env, q, part) {
  const ref = channelRef(q.get("c"));
  if (!ref) throw ytError("bad_channel");
  if (ref.video) {
    const j = await api(env, "videos", { part: "snippet", id: ref.video });
    const cid = j.items?.[0]?.snippet?.channelId;
    if (!cid) throw ytError("not_found", 404);
    ref.id = cid;
  }
  const params = { part, hl: langOf(q.get("hl")) };
  if (ref.id) params.id = ref.id;
  else if (ref.handle) params.forHandle = ref.handle;
  else params.forUsername = ref.user;
  const j = await api(env, "channels", params);
  const c = j.items?.[0];
  if (!c) throw ytError("not_found", 404);
  return c;
}

// The latest uploads, 50 per page (2 units a page).
async function latestUploads(env, c, pages = 1) {
  const uploads = c.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];
  const out = [];
  let pageToken;
  for (let p = 0; p < pages; p++) {
    const pl = await api(env, "playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: 50, pageToken }).catch(() => null);
    const ids = (pl?.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
    if (!ids.length) break;
    const vs = await api(env, "videos", { part: "snippet,statistics,contentDetails", id: ids.join(","), maxResults: 50 }).catch(() => null);
    out.push(...(vs?.items || []));
    pageToken = pl.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export function median(list) {
  const a = list.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

// Likes and comments per 100 views, over videos that show both.
function engagement(videos) {
  let views = 0, acts = 0;
  for (const v of videos) {
    const st = v.statistics || {};
    if (st.viewCount == null || st.likeCount == null) continue;
    views += +st.viewCount;
    acts += +st.likeCount + (+st.commentCount || 0);
  }
  return views ? Math.round((acts / views) * 1000) / 10 : null;
}

function channelHead(c) {
  const s = c.snippet || {};
  const st = c.statistics || {};
  return {
    id: c.id,
    title: s.localized?.title || s.title || "",
    handle: s.customUrl || null,
    thumb: bestThumb(s.thumbnails),
    subscribers: st.hiddenSubscriberCount ? null : +st.subscriberCount || 0,
    views: +st.viewCount || 0,
    videos: +st.videoCount || 0,
  };
}

export async function getChannel(env, q) {
  const c = await findChannel(env, q, "snippet,statistics,brandingSettings,topicDetails,contentDetails");
  // The latest 50 uploads: the tags the channel really uses, its most viewed videos and how often it posts.
  const recent = await latestUploads(env, c, 1);
  const dates = recent.map((v) => Date.parse(v.snippet?.publishedAt)).filter(Number.isFinite).sort((a, b) => b - a);
  const span = dates.length > 1 ? (dates[0] - dates[dates.length - 1]) / (7 * 86400_000) : 0;
  const views = recent.map((v) => +v.statistics?.viewCount || 0);
  const s = c.snippet || {};
  return {
    ...channelHead(c),
    description: s.localized?.description || s.description || "",
    country: s.country || null,
    created: s.publishedAt || null,
    banner: c.brandingSettings?.image?.bannerExternalUrl || null,
    keywords: splitKeywords(c.brandingSettings?.channel?.keywords),
    topics: topics(c.topicDetails?.topicCategories),
    sample: recent.length,
    avgViews: views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : null,
    medianViews: median(views),
    engagement: engagement(recent),
    perWeek: span > 0 ? Math.round(((dates.length - 1) / span) * 10) / 10 : null,
    lastUpload: dates.length ? new Date(dates[0]).toISOString() : null,
    tags: tagCounts(recent, 50),
    top: recent.map(videoCard).sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 8),
  };
}

// Outliers: the latest 100 uploads, each with its views against the channel's median (how vidIQ-style tools spot
// the ideas that took off). Videos younger than 2 days are marked, because their views are still climbing.
export async function getOutliers(env, q) {
  const c = await findChannel(env, q, "snippet,statistics,contentDetails");
  const list = await latestUploads(env, c, 2);
  const now = Date.now();
  const med = median(list.map((v) => +v.statistics?.viewCount || 0));
  const uploads = list.map((v) => {
    const views = +v.statistics?.viewCount || 0;
    const age = Math.max(1, (now - Date.parse(v.snippet?.publishedAt)) / 86400_000);
    return {
      ...videoCard(v),
      likes: v.statistics?.likeCount != null ? +v.statistics.likeCount : null,
      comments: v.statistics?.commentCount != null ? +v.statistics.commentCount : null,
      duration: seconds(v.contentDetails?.duration),
      perDay: Math.round(views / age),
      score: med ? Math.round((views / med) * 10) / 10 : null,
      fresh: age < 2,
    };
  });
  return { ...channelHead(c), sample: uploads.length, medianViews: med, uploads };
}

// ----- Channel health report -----
// A channel's uploads in a period (the last 30, 90 or 365 days, or its whole life) scored on five public signals:
// how regularly it posts, how many of its subscribers it reaches, how viewers react, whether recent videos do better
// or worse than earlier ones, and its SEO habits. Watch time, impressions and revenue are private to the channel's
// owner, so they can't be part of it. At most the latest 300 uploads are read (about 13 units).
export const PERIODS = { 30: 30, 90: 90, 365: 365, all: null };
const MAX_PAGES = 6;
const DAY = 86400_000;

// The uploads published since a time (0 = all), newest first, stopping as soon as a page reaches older ones.
async function uploadsSince(env, c, since) {
  const uploads = c.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { list: [], capped: false };
  const out = [];
  let pageToken, capped = false;
  for (let p = 0; p < MAX_PAGES; p++) {
    const pl = await api(env, "playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: 50, pageToken, fields: "nextPageToken,items/contentDetails(videoId,videoPublishedAt)" }).catch(() => null);
    const items = (pl?.items || []).map((i) => i.contentDetails).filter((d) => d?.videoId);
    const ids = items.filter((d) => !since || Date.parse(d.videoPublishedAt) >= since).map((d) => d.videoId);
    if (ids.length) {
      const vs = await api(env, "videos", {
        part: "snippet,statistics,contentDetails", id: ids.join(","), maxResults: 50,
        fields: "items(id,snippet(publishedAt,title,description,tags,defaultAudioLanguage,defaultLanguage),statistics,contentDetails(duration,caption))",
      }).catch(() => null);
      out.push(...(vs?.items || []));
    }
    pageToken = pl?.nextPageToken;
    if (!pageToken || ids.length < items.length) break;
    if (p === MAX_PAGES - 1) capped = true;
  }
  out.sort((a, b) => Date.parse(b.snippet?.publishedAt) - Date.parse(a.snippet?.publishedAt));
  return { list: out, capped };
}

// Straight-line steps between [value, score] points, for scores that rise smoothly instead of in jumps.
export function scale(x, points) {
  if (x == null || !Number.isFinite(x)) return null;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x0, y0] = points[i - 1];
    if (x <= x1) return Math.round(y0 + ((x - x0) / (x1 - x0)) * (y1 - y0));
  }
  return points[points.length - 1][1];
}
const share = (list, test) => (list.length ? Math.round((list.filter(test).length / list.length) * 100) : null);
const WEIGHTS = { consistency: 0.2, reach: 0.25, engagement: 0.2, momentum: 0.2, seo: 0.15 };

export function healthReport(c, list, { period, since, capped, now = Date.now() }) {
  const vids = list.map((v) => {
    const s = v.snippet || {}, st = v.statistics || {};
    const desc = s.description || "";
    return {
      id: v.id,
      title: s.title || "",
      published: s.publishedAt || null,
      views: st.viewCount != null ? +st.viewCount : null,
      likes: st.likeCount != null ? +st.likeCount : null,
      comments: st.commentCount != null ? +st.commentCount : null,
      duration: seconds(v.contentDetails?.duration),
      tags: (s.tags || []).length,
      words: desc.split(/\s+/).filter(Boolean).length,
      chapters: /(^|\n)\s*\(?0?0:00\b/.test(desc),
      hashtags: hashtags(desc).length,
      links: /https?:\/\//.test(desc),
      captions: v.contentDetails?.caption === "true",
      lang: !!(s.defaultAudioLanguage || s.defaultLanguage),
    };
  });
  const head = channelHead(c);
  const views = vids.map((v) => v.views || 0);
  const med = median(views);
  vids.forEach((v) => { v.score = med ? Math.round(((v.views || 0) / med) * 10) / 10 : null; });
  const sum = (k) => vids.reduce((n, v) => n + (v[k] || 0), 0);
  const dates = vids.map((v) => Date.parse(v.published)).filter(Number.isFinite);
  const gaps = dates.slice(1).map((d, i) => (dates[i] - d) / DAY);
  // The window the uploads are spread over: the period itself, or the channel's life up to the oldest upload read.
  const spanDays = since ? (now - since) / DAY : dates.length ? (now - dates[dates.length - 1]) / DAY : 0;
  const perWeek = spanDays > 0 ? Math.round((vids.length / spanDays) * 7 * 10) / 10 : null;
  const sinceLast = dates.length ? Math.floor((now - dates[0]) / DAY) : null;
  const eng = engagement(list);
  const shorts = vids.filter((v) => v.duration && v.duration <= 180);
  const long = vids.filter((v) => v.duration > 180);
  // Momentum: the newer half of the uploads against the older half, leaving out videos still in their first week.
  const settled = vids.filter((v) => now - Date.parse(v.published) >= 7 * DAY);
  const half = Math.floor(settled.length / 2);
  const recentMed = settled.length >= 6 ? median(settled.slice(0, half).map((v) => v.views || 0)) : null;
  const earlierMed = settled.length >= 6 ? median(settled.slice(settled.length - half).map((v) => v.views || 0)) : null;
  const change = recentMed != null && earlierMed ? Math.round((recentMed / earlierMed) * 100) / 100 : null;
  const seo = {
    tags: share(vids, (v) => v.tags >= 5),
    titles: share(vids, (v) => v.title.length >= 20 && v.title.length <= 70),
    descriptions: share(vids, (v) => v.words >= 100),
    chapters: share(vids.filter((v) => v.duration >= 240), (v) => v.chapters),
    hashtags: share(vids, (v) => v.hashtags >= 1 && v.hashtags <= 15),
    links: share(vids, (v) => v.links),
    captions: share(vids, (v) => v.captions),
    language: share(vids, (v) => v.lang),
  };
  const kw = splitKeywords(c.brandingSettings?.channel?.keywords).length;
  const seoParts = Object.values(seo).filter((n) => n != null).concat(kw ? 100 : 0);

  let consistency = null;
  if (vids.length) {
    consistency = scale(perWeek, [[0, 10], [0.25, 40], [0.5, 60], [1, 80], [2, 95], [3, 100]]);
    if (sinceLast > 90) consistency = Math.min(consistency, 20);
    else if (sinceLast > 30) consistency -= 20;
    if (vids.length < 2) consistency = Math.min(consistency, 30);
    consistency = Math.max(0, consistency);
  } else consistency = 0;
  const reachPct = head.subscribers && med != null ? Math.round((med / head.subscribers) * 1000) / 10 : null;
  const scores = {
    consistency,
    reach: scale(reachPct, [[0, 5], [1, 25], [2, 40], [5, 60], [10, 80], [30, 100]]),
    engagement: scale(eng, [[0, 5], [1.5, 45], [2.5, 65], [4, 85], [6, 100]]),
    momentum: scale(change, [[0.3, 10], [0.6, 40], [0.9, 65], [1.1, 80], [1.5, 100]]),
    seo: seoParts.length ? Math.round(seoParts.reduce((a, b) => a + b, 0) / seoParts.length) : null,
  };
  let wsum = 0, total = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) if (scores[k] != null) { wsum += w; total += scores[k] * w; }
  const overall = wsum ? Math.round(total / wsum) : null;
  const grade = overall == null ? null : overall >= 85 ? "A" : overall >= 70 ? "B" : overall >= 55 ? "C" : overall >= 40 ? "D" : "F";

  // What to improve, most important first. The page writes each one out in the visitor's language.
  const tips = [];
  const tip = (code, sev, params = {}) => tips.push({ code, sev, ...params });
  if (!vids.length) tip("no_uploads", "high");
  else {
    if (sinceLast > 30) tip("long_gap", "high", { n: sinceLast });
    if (perWeek != null && perWeek < 1) tip("post_more", perWeek < 0.25 ? "high" : "medium", { n: perWeek });
    if (gaps.length >= 3 && Math.max(...gaps) > 4 * (median(gaps) || 1) && Math.max(...gaps) > 14) tip("uneven", "low", { n: Math.round(Math.max(...gaps)) });
    if (scores.reach != null && scores.reach < 45) tip("reach_low", "medium", { n: reachPct });
    if (scores.engagement != null && scores.engagement < 50) tip("engagement_low", "medium", { n: eng });
    if (change != null && change < 0.8) tip("momentum_down", "high", { n: Math.round((1 - change) * 100) });
    if (change != null && change >= 1.2) tip("momentum_up", "good", { n: Math.round((change - 1) * 100) });
    const sm = median(shorts.map((v) => v.views || 0)), lm = median(long.map((v) => v.views || 0));
    if (shorts.length >= 3 && long.length >= 3 && sm && lm) {
      if (sm >= lm * 2) tip("shorts_win", "good", { n: Math.round((sm / lm) * 10) / 10 });
      else if (lm >= sm * 2) tip("long_win", "good", { n: Math.round((lm / sm) * 10) / 10 });
    }
    if (seo.chapters != null && seo.chapters < 50) tip("seo_chapters", "low", { n: seo.chapters });
    if (seo.captions != null && seo.captions < 50) tip("seo_captions", "low", { n: seo.captions });
    if (seo.descriptions != null && seo.descriptions < 50) tip("seo_desc", "medium", { n: seo.descriptions });
    if (seo.tags != null && seo.tags < 50) tip("seo_tags", "low", { n: seo.tags });
    if (seo.hashtags != null && seo.hashtags < 50) tip("seo_hashtags", "low", { n: seo.hashtags });
    if (!kw) tip("channel_keywords", "low");
    if (vids.filter((v) => v.score >= 3).length) tip("outliers", "good", { n: vids.filter((v) => v.score >= 3).length });
  }
  const order = { high: 0, medium: 1, low: 2, good: 3 };
  tips.sort((a, b) => order[a.sev] - order[b.sev]);

  return {
    ...head,
    created: c.snippet?.publishedAt || null,
    country: c.snippet?.country || null,
    keywords: kw,
    period,
    since: since ? new Date(since).toISOString() : null,
    sample: vids.length,
    capped,
    totals: { views: sum("views"), likes: sum("likes"), comments: sum("comments") },
    medianViews: med,
    avgViews: vids.length ? Math.round(sum("views") / vids.length) : null,
    engagement: eng,
    reach: reachPct,
    perWeek,
    sinceLast,
    longestGap: gaps.length ? Math.round(Math.max(...gaps)) : null,
    momentum: { recent: recentMed, earlier: earlierMed, change },
    formats: { shorts: shorts.length, long: long.length, shortsMedian: median(shorts.map((v) => v.views || 0)), longMedian: median(long.map((v) => v.views || 0)) },
    seo,
    scores,
    overall,
    grade,
    tips,
    tags: tagCounts(list, 40),
    uploads: vids.map(({ id, title, published, views, likes, comments, duration, score }) => ({ id, title, published, views, likes, comments, duration, score })),
  };
}

export async function getReport(env, q) {
  const period = Object.hasOwn(PERIODS, q.get("p")) ? q.get("p") : "90";
  const c = await findChannel(env, q, "snippet,statistics,contentDetails,brandingSettings");
  const now = Date.now();
  const since = PERIODS[period] ? now - PERIODS[period] * DAY : 0;
  const { list, capped } = await uploadsSince(env, c, since);
  return healthReport(c, list, { period, since, capped, now });
}

export async function getCategories(env, q) {
  const gl = regionOf(q.get("gl"));
  const hl = langOf(q.get("hl"));
  const j = await api(env, "videoCategories", { part: "snippet", regionCode: gl, hl });
  return {
    gl,
    categories: (j.items || []).filter((c) => c.snippet?.assignable).map((c) => ({ id: c.id, title: c.snippet.title })),
  };
}

export async function getTrending(env, q) {
  const gl = regionOf(q.get("gl"));
  const hl = langOf(q.get("hl"));
  const cat = /^\d{1,3}$/.test(q.get("cat") || "") ? q.get("cat") : "";
  const j = await api(env, "videos", { part: "snippet,statistics", chart: "mostPopular", regionCode: gl, videoCategoryId: cat, maxResults: 50, hl });
  const items = j.items || [];
  if (!items.length) throw ytError("no_chart", 404);
  return { gl, cat: cat || null, count: items.length, tags: tagCounts(items, 60), videos: items.slice(0, 10).map(videoCard) };
}

// ----- Keyword ideas (YouTube search autocomplete) -----

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
const QUESTIONS = { en: ["how to", "what is", "why", "best"], de: ["wie", "was ist", "warum", "beste"], ur: ["کیسے", "کیا ہے", "کیوں", "بہترین"], zh: ["如何", "什么是", "为什么", "最好的"] };

async function suggestOne(query, hl, gl) {
  const u = new URL("https://suggestqueries.google.com/complete/search");
  u.searchParams.set("client", "firefox");
  u.searchParams.set("ds", "yt");
  u.searchParams.set("hl", hl);
  u.searchParams.set("gl", gl);
  u.searchParams.set("q", query);
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(6000), headers: { "user-agent": "Mozilla/5.0 (sanaullahniazi.com YouTube keyword tool)" } });
    if (!r.ok) return [];
    // The answer is ["query", ["suggestion", ...]], sometimes in a legacy encoding for non-Latin languages.
    const buf = await r.arrayBuffer();
    const cs = (r.headers.get("content-type") || "").match(/charset=([\w-]+)/i)?.[1] || "utf-8";
    let text;
    try { text = new TextDecoder(cs).decode(buf); } catch { text = new TextDecoder().decode(buf); }
    const j = JSON.parse(text);
    return Array.isArray(j?.[1]) ? j[1].filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export async function getSuggestions(env, q) {
  const seed = String(q.get("q") || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (seed.length < 2 || seed.length > 80) throw ytError("bad_keyword");
  const hl = langOf(q.get("hl"));
  const gl = regionOf(q.get("gl"));
  const base = hl.split("-")[0];
  // One plain lookup, one per letter after the keyword, and a few question starters. 31 requests, under the 50 a free
  // Worker may make.
  const groups = [{ key: "top", q: seed }];
  for (const l of LETTERS) groups.push({ key: "letter", label: l, q: `${seed} ${l}` });
  for (const w of QUESTIONS[base] || QUESTIONS.en) groups.push({ key: "question", label: w, q: base === "ur" ? `${seed} ${w}` : `${w} ${seed}` });
  const answers = await Promise.all(groups.map((g) => suggestOne(g.q, hl, gl)));
  const seen = new Set();
  const out = { top: [], letters: [], questions: [] };
  groups.forEach((g, i) => {
    const list = answers[i].map((s) => s.trim()).filter((s) => s && !seen.has(s.toLowerCase()));
    list.forEach((s) => seen.add(s.toLowerCase()));
    if (!list.length) return;
    if (g.key === "top") out.top = list;
    else if (g.key === "letter") out.letters.push({ label: g.label, ideas: list });
    else out.questions.push(...list);
  });
  if (!seen.size) throw ytError("no_ideas", 404);
  return { q: seed, hl, gl, count: seen.size, ...out };
}

// ----- Transcripts -----

// Caption files come as XML (<text start dur> or the newer <p t d> with <s> words) or JSON (events with segs).
export function parseCaptions(body) {
  const lines = [];
  const text = String(body || "").trim();
  if (text.startsWith("{")) {
    let j;
    try { j = JSON.parse(text); } catch { return lines; }
    for (const e of j.events || []) {
      const t = (e.segs || []).map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
      if (t) lines.push({ t: (e.tStartMs || 0) / 1000, d: (e.dDurationMs || 0) / 1000, text: t });
    }
    return lines;
  }
  for (const m of text.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const t = decodeXml(m[2]);
    if (t) lines.push({ t: +attr(m[1], "start") || 0, d: +attr(m[1], "dur") || 0, text: t });
  }
  if (lines.length) return lines;
  for (const m of text.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const t = decodeXml(m[2].replace(/<[^>]+>/g, ""));
    if (t) lines.push({ t: (+attr(m[1], "t") || 0) / 1000, d: (+attr(m[1], "d") || 0) / 1000, text: t });
  }
  return lines;
}
function attr(s, name) { return (s.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1]; }
// The older format escapes twice (&amp;#39;), so entities are decoded twice.
function decodeXml(s) {
  return entities(entities(s.replace(/<[^>]+>/g, ""))).replace(/\s+/g, " ").trim();
}
function entities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// The caption tracks the YouTube player gets for a video.
async function captionTracks(id) {
  const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)" },
    body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en" } }, videoId: id }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw ytError("transcript_blocked", 502);
  const j = await r.json().catch(() => ({}));
  const status = j.playabilityStatus?.status;
  if (status === "LOGIN_REQUIRED" && /bot/i.test(j.playabilityStatus?.reason || "")) throw ytError("transcript_blocked", 502);
  if (status && status !== "OK" && !j.captions) throw ytError("not_found", 404);
  const tracks = (j.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).map((t) => ({
    url: t.baseUrl,
    lang: t.languageCode,
    name: t.name?.simpleText || (t.name?.runs || []).map((x) => x.text).join("") || t.languageCode,
    auto: t.kind === "asr",
  }));
  return { tracks, title: j.videoDetails?.title || "", channel: j.videoDetails?.author || "" };
}

export async function getTranscript(env, q) {
  if (String(env.YT_TRANSCRIPTS || "on") === "off") throw ytError("not_configured", 503);
  const id = videoId(q.get("v"));
  if (!id) throw ytError("bad_video");
  const { tracks, title, channel } = await captionTracks(id);
  if (!tracks.length) throw ytError("no_captions", 404);
  const want = q.get("lang");
  // The chosen language, else a track someone wrote over an automatic one.
  const track = tracks.find((t) => t.lang === want) || tracks.find((t) => !t.auto) || tracks[0];
  const u = new URL(track.url);
  if (!/(^|\.)youtube\.com$/.test(u.hostname)) throw ytError("upstream", 502);
  u.searchParams.delete("fmt");
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw ytError("transcript_blocked", 502);
  const lines = parseCaptions(await r.text());
  if (!lines.length) throw ytError("transcript_blocked", 502);
  return { id, title, channel, lang: track.lang, auto: track.auto, tracks: tracks.map(({ lang, name, auto }) => ({ lang, name, auto })), lines };
}

// ----- Thumbnails -----

export async function getThumb(q) {
  const id = videoId(q.get("v"));
  const size = THUMBS[q.get("q")] ? q.get("q") : "hq";
  if (!id) throw ytError("bad_video");
  const r = await fetch(`https://i.ytimg.com/vi/${id}/${THUMBS[size]}.jpg`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw ytError("not_found", 404);
  return new Response(r.body, {
    headers: {
      "content-type": "image/jpeg",
      "content-disposition": `attachment; filename="${id}-${size}.jpg"`,
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}

// ----- The router (called from index.js) -----

const ROUTES = {
  video: { run: getVideo, hours: 6 },
  channel: { run: getChannel, hours: 6 },
  outliers: { run: getOutliers, hours: 6 },
  report: { run: getReport, hours: 6 },
  suggest: { run: getSuggestions, hours: 24 },
  categories: { run: getCategories, hours: 168 },
  trending: { run: getTrending, hours: 2 },
  transcript: { run: getTranscript, hours: 24 },
};

// limit(): counts one request for the visitor (throws when over the limit). Only fresh lookups are counted; answers
// already in Cloudflare's cache are served without asking YouTube again.
export async function handleYt(request, env, ctx, name, { cors, limit }) {
  if (request.method !== "GET") throw ytError("not_found", 404);
  const url = new URL(request.url);
  if (name === "thumb") {
    await limit();
    const res = await getThumb(url.searchParams);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
  const route = ROUTES[name];
  if (!route) throw ytError("not_found", 404);

  // Cache key: the route and its sorted parameters, without the origin.
  const params = [...url.searchParams.entries()].filter(([k]) => ["v", "c", "q", "hl", "gl", "cat", "lang", "p"].includes(k)).sort();
  const key = new Request(`https://yt-cache.internal/${name}?${new URLSearchParams(params)}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const hit = cache && (await cache.match(key));
  let body;
  if (hit) body = await hit.text();
  else {
    await limit();
    body = JSON.stringify(await route.run(env, url.searchParams));
    if (cache) {
      const put = cache.put(key, new Response(body, { headers: { "cache-control": `public, max-age=${route.hours * 3600}` } }));
      ctx?.waitUntil ? ctx.waitUntil(put) : await put;
    }
  }
  return new Response(body, {
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" },
  });
}
