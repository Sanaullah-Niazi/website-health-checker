// YouTube creator tools (/tools/youtube/ on sanaullahniazi.com). Every route is a GET, so answers can be cached.
//
//   GET /yt/video?v=<link or id>&hl=en                 title, tags, category and numbers of one video
//   GET /yt/channel?c=<link, @handle or id>&hl=en      channel details, its own keywords and the tags its latest uploads use
//   GET /yt/suggest?q=<keyword>&hl=en&gl=US            keyword ideas from YouTube search's autocomplete
//   GET /yt/categories?gl=US&hl=en                     the video categories of a country
//   GET /yt/trending?gl=US&cat=<id>&hl=en              the tags most used by the trending videos of a category
//   GET /yt/transcript?v=<link or id>&lang=<code>      the captions of a video, as lines with times
//   GET /yt/thumb?v=<id>&q=maxres                      a thumbnail as a download (needs no API key)
//
// Video, channel, category and trending data come from the official YouTube Data API v3 (secret YT_KEY, 10,000 quota
// units a day for free; every call here costs 1 unit). Keyword ideas use the public autocomplete that YouTube's own
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

export async function getChannel(env, q) {
  const ref = channelRef(q.get("c"));
  if (!ref) throw ytError("bad_channel");
  const hl = langOf(q.get("hl"));
  if (ref.video) {
    const j = await api(env, "videos", { part: "snippet", id: ref.video });
    const cid = j.items?.[0]?.snippet?.channelId;
    if (!cid) throw ytError("not_found", 404);
    ref.id = cid;
  }
  const part = "snippet,statistics,brandingSettings,topicDetails,contentDetails";
  const params = { part, hl };
  if (ref.id) params.id = ref.id;
  else if (ref.handle) params.forHandle = ref.handle;
  else params.forUsername = ref.user;
  const j = await api(env, "channels", params);
  const c = j.items?.[0];
  if (!c) throw ytError("not_found", 404);

  // The latest 50 uploads: the tags the channel really uses, its most viewed videos and how often it posts.
  let recent = [];
  const uploads = c.contentDetails?.relatedPlaylists?.uploads;
  if (uploads) {
    const pl = await api(env, "playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: 50 }).catch(() => null);
    const ids = (pl?.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
    if (ids.length) {
      const vs = await api(env, "videos", { part: "snippet,statistics", id: ids.join(","), maxResults: 50 }).catch(() => null);
      recent = vs?.items || [];
    }
  }
  const dates = recent.map((v) => Date.parse(v.snippet?.publishedAt)).filter(Number.isFinite).sort((a, b) => b - a);
  const span = dates.length > 1 ? (dates[0] - dates[dates.length - 1]) / (7 * 86400_000) : 0;
  const views = recent.map((v) => +v.statistics?.viewCount || 0);
  const s = c.snippet || {};
  const st = c.statistics || {};
  return {
    id: c.id,
    title: s.localized?.title || s.title || "",
    handle: s.customUrl || null,
    description: s.localized?.description || s.description || "",
    country: s.country || null,
    created: s.publishedAt || null,
    thumb: bestThumb(s.thumbnails),
    banner: c.brandingSettings?.image?.bannerExternalUrl || null,
    keywords: splitKeywords(c.brandingSettings?.channel?.keywords),
    topics: topics(c.topicDetails?.topicCategories),
    subscribers: st.hiddenSubscriberCount ? null : +st.subscriberCount || 0,
    views: +st.viewCount || 0,
    videos: +st.videoCount || 0,
    sample: recent.length,
    avgViews: views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : null,
    perWeek: span > 0 ? Math.round(((dates.length - 1) / span) * 10) / 10 : null,
    lastUpload: dates.length ? new Date(dates[0]).toISOString() : null,
    tags: tagCounts(recent, 50),
    top: recent.map(videoCard).sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 8),
  };
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
  const params = [...url.searchParams.entries()].filter(([k]) => ["v", "c", "q", "hl", "gl", "cat", "lang"].includes(k)).sort();
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
