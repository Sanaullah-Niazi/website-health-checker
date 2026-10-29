// Run with: npm test (plain Node, no Cloudflare needed). YouTube is replaced by a fake fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { videoId, channelRef, seconds, splitKeywords, hashtags, tagCounts, topics, parseCaptions, getVideo, getChannel, getOutliers, median, getReport, healthReport, scale, getSuggestions, getTrending, handleYt } from "../src/yt.js";

test("video ids are read from every kind of YouTube link", () => {
  const id = "dQw4w9WgXcQ";
  for (const s of [
    id,
    `https://www.youtube.com/watch?v=${id}&t=42s`,
    `youtube.com/watch?feature=share&v=${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&list=RD`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}?start=3`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ]) assert.equal(videoId(s), id, s);
  for (const s of ["", "hello", "https://vimeo.com/123", `https://evil.com/watch?v=${id}`, "https://youtu.be/short", "https://www.youtube.com/@channel"]) {
    assert.equal(videoId(s), null, s);
  }
});

test("channel links, handles and ids are recognised", () => {
  const cid = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
  assert.deepEqual(channelRef(cid), { id: cid });
  assert.deepEqual(channelRef(`https://www.youtube.com/channel/${cid}/videos`), { id: cid });
  assert.deepEqual(channelRef("@GoogleDevelopers"), { handle: "@GoogleDevelopers" });
  assert.deepEqual(channelRef("https://www.youtube.com/@GoogleDevelopers/shorts"), { handle: "@GoogleDevelopers" });
  assert.deepEqual(channelRef("GoogleDevelopers"), { handle: "@GoogleDevelopers" });
  assert.deepEqual(channelRef("https://youtube.com/user/GoogleDevelopers"), { user: "GoogleDevelopers" });
  assert.deepEqual(channelRef("https://www.youtube.com/c/GoogleDevelopers"), { handle: "@GoogleDevelopers" });
  assert.deepEqual(channelRef("https://youtu.be/dQw4w9WgXcQ"), { video: "dQw4w9WgXcQ" });
  assert.deepEqual(channelRef("https://www.youtube.com/@%D8%B3%D9%84%D8%A7%D9%85"), { handle: "@سلام" });
  for (const s of ["", "https://example.com/@x", "a", "https://www.youtube.com/"]) assert.equal(channelRef(s), null, s);
});

test("small helpers", () => {
  assert.equal(seconds("PT1H2M3S"), 3723);
  assert.equal(seconds("PT45S"), 45);
  assert.equal(seconds("P1DT1M"), 86460);
  assert.equal(seconds("bad"), 0);
  assert.deepEqual(splitKeywords('cyber security "ai safety" phishing cyber'), ["cyber", "security", "ai safety", "phishing"]);
  assert.deepEqual(hashtags("Watch #Python and #python #AI_tips (#سائبر) mail@x.com#no"), ["#Python", "#AI_tips", "#سائبر"]);
  assert.deepEqual(topics(["https://en.wikipedia.org/wiki/Video_game_culture", "https://en.wikipedia.org/wiki/Technology"]), ["Video game culture", "Technology"]);
  const counts = tagCounts([{ snippet: { tags: ["AI", "python", "ai"] } }, { snippet: { tags: ["Python"] } }, { snippet: {} }]);
  assert.deepEqual(counts, [{ tag: "python", n: 2 }, { tag: "AI", n: 1 }]);
});

test("caption files in all three formats", () => {
  const xml = '<?xml version="1.0"?><transcript><text start="0.5" dur="2.1">Hello &amp;amp; welcome</text><text start="2.6" dur="1">it&#39;s &quot;fine&quot;</text></transcript>';
  assert.deepEqual(parseCaptions(xml), [{ t: 0.5, d: 2.1, text: "Hello & welcome" }, { t: 2.6, d: 1, text: 'it\'s "fine"' }]);
  const srv3 = '<timedtext format="3"><body><p t="1000" d="1500"><s>Salam</s><s t="300"> sab</s></p><p t="3000" d="900">ko</p></body></timedtext>';
  assert.deepEqual(parseCaptions(srv3), [{ t: 1, d: 1.5, text: "Salam sab" }, { t: 3, d: 0.9, text: "ko" }]);
  const json3 = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: "Hallo" }, { utf8: " Welt" }] }, { tStartMs: 1300, segs: [{ utf8: "\n" }] }] });
  assert.deepEqual(parseCaptions(json3), [{ t: 0, d: 1.2, text: "Hallo Welt" }]);
});

// A fake fetch that answers like the YouTube Data API.
function fakeFetch(routes) {
  const calls = [];
  const f = async (input) => {
    const u = new URL(typeof input === "string" ? input : input.url || input);
    calls.push(u);
    for (const [prefix, answer] of Object.entries(routes)) {
      if (u.href.startsWith(prefix)) {
        const a = typeof answer === "function" ? answer(u) : answer;
        return new Response(typeof a === "string" ? a : JSON.stringify(a), { status: a?.status || 200, headers: { "content-type": "application/json; charset=UTF-8" } });
      }
    }
    return new Response("{}", { status: 404 });
  };
  f.calls = calls;
  return f;
}

const env = { YT_KEY: "test-key" };

test("a video's tags, category and numbers", async (t) => {
  const f = fakeFetch({
    "https://www.googleapis.com/youtube/v3/videos": {
      items: [{
        id: "dQw4w9WgXcQ",
        snippet: { title: "T", channelTitle: "C", channelId: "UC1", publishedAt: "2020-01-01T00:00:00Z", description: "Hi #music", tags: ["rick astley", "music"], categoryId: "10", thumbnails: { high: { url: "https://i.ytimg.com/hq.jpg" } } },
        statistics: { viewCount: "100", likeCount: "5", commentCount: "2" },
        contentDetails: { duration: "PT3M33S", caption: "true" },
      }],
    },
    "https://www.googleapis.com/youtube/v3/videoCategories": { items: [{ id: "10", snippet: { title: "Music" } }] },
  });
  t.mock.method(globalThis, "fetch", f);
  const v = await getVideo(env, new URLSearchParams({ v: "https://youtu.be/dQw4w9WgXcQ" }));
  assert.equal(v.category, "Music");
  assert.deepEqual(v.tags, ["rick astley", "music"]);
  assert.equal(v.tagChars, 13 + 5 + 1);
  assert.deepEqual(v.hashtags, ["#music"]);
  assert.equal(v.duration, 213);
  assert.equal(v.views, 100);
  assert.equal(f.calls[0].searchParams.get("key"), "test-key");
});

test("no API key means not configured, a quota error is passed on", async (t) => {
  await assert.rejects(getVideo({}, new URLSearchParams({ v: "dQw4w9WgXcQ" })), { code: "not_configured" });
  t.mock.method(globalThis, "fetch", fakeFetch({ "https://www.googleapis.com/": { status: 403, error: { errors: [{ reason: "quotaExceeded" }] } } }));
  await assert.rejects(getVideo(env, new URLSearchParams({ v: "dQw4w9WgXcQ" })), { code: "quota" });
});

test("a channel's keywords, tags of its uploads and posting rate", async (t) => {
  const week = 7 * 86400_000;
  const f = fakeFetch({
    "https://www.googleapis.com/youtube/v3/channels": (u) => {
      assert.equal(u.searchParams.get("forHandle"), "@sana");
      return {
        items: [{
          id: "UC1", snippet: { title: "Sana", customUrl: "@sana", publishedAt: "2019-05-01T00:00:00Z", country: "PK", thumbnails: { high: { url: "x" } } },
          statistics: { subscriberCount: "1200", viewCount: "50000", videoCount: "30", hiddenSubscriberCount: false },
          brandingSettings: { channel: { keywords: 'security "ai safety"' } },
          topicDetails: { topicCategories: ["https://en.wikipedia.org/wiki/Technology"] },
          contentDetails: { relatedPlaylists: { uploads: "UU1" } },
        }],
      };
    },
    "https://www.googleapis.com/youtube/v3/playlistItems": { items: [{ contentDetails: { videoId: "a" } }, { contentDetails: { videoId: "b" } }, { contentDetails: { videoId: "c" } }] },
    "https://www.googleapis.com/youtube/v3/videos": {
      items: [
        { id: "a", snippet: { title: "A", publishedAt: new Date(2 * week).toISOString(), tags: ["phishing", "ai"] }, statistics: { viewCount: "300" } },
        { id: "b", snippet: { title: "B", publishedAt: new Date(1 * week).toISOString(), tags: ["phishing"] }, statistics: { viewCount: "900" } },
        { id: "c", snippet: { title: "C", publishedAt: new Date(0).toISOString() }, statistics: { viewCount: "0" } },
      ],
    },
  });
  t.mock.method(globalThis, "fetch", f);
  const c = await getChannel(env, new URLSearchParams({ c: "https://www.youtube.com/@sana" }));
  assert.deepEqual(c.keywords, ["security", "ai safety"]);
  assert.deepEqual(c.topics, ["Technology"]);
  assert.equal(c.subscribers, 1200);
  assert.deepEqual(c.tags[0], { tag: "phishing", n: 2 });
  assert.equal(c.avgViews, 400);
  assert.equal(c.perWeek, 1);
  assert.equal(c.top[0].id, "b");
});

test("keyword ideas are merged without repeats", async (t) => {
  const f = fakeFetch({
    "https://suggestqueries.google.com/": (u) => {
      const q = u.searchParams.get("q");
      if (q === "python") return ["python", ["python tutorial", "python for beginners"]];
      if (q === "python a") return ["python a", ["python ai", "python tutorial"]];
      if (q === "how to python") return ["how to python", ["how to python code"]];
      return [q, []];
    },
  });
  t.mock.method(globalThis, "fetch", f);
  const r = await getSuggestions(env, new URLSearchParams({ q: " Python ", hl: "en", gl: "PK" }));
  assert.equal(f.calls.length, 31);
  assert.deepEqual(r.top, ["python tutorial", "python for beginners"]);
  assert.deepEqual(r.letters, [{ label: "a", ideas: ["python ai"] }]);
  assert.deepEqual(r.questions, ["how to python code"]);
  assert.equal(r.count, 4);
  assert.equal(f.calls[0].searchParams.get("gl"), "PK");
  await assert.rejects(getSuggestions(env, new URLSearchParams({ q: "x" })), { code: "bad_keyword" });
});

test("trending tags of a category", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({
    "https://www.googleapis.com/youtube/v3/videos": (u) => {
      assert.equal(u.searchParams.get("chart"), "mostPopular");
      assert.equal(u.searchParams.get("regionCode"), "PK");
      assert.equal(u.searchParams.get("videoCategoryId"), "20");
      return { items: [{ id: "a", snippet: { title: "A", tags: ["pubg", "gaming"] }, statistics: { viewCount: "5" } }, { id: "b", snippet: { title: "B", tags: ["gaming"] } }] };
    },
  }));
  const r = await getTrending(env, new URLSearchParams({ gl: "pk", cat: "20" }));
  assert.deepEqual(r.tags[0], { tag: "gaming", n: 2 });
  assert.equal(r.count, 2);
});

test("the router counts only fresh lookups and refuses other methods", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ "https://suggestqueries.google.com/": ["x", ["seo tips"]] }));
  let counted = 0;
  const opts = { cors: { "access-control-allow-origin": "https://sanaullahniazi.com" }, limit: async () => { counted++; } };
  const res = await handleYt(new Request("https://api.sanaullahniazi.com/yt/suggest?q=seo"), env, null, "suggest", opts);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://sanaullahniazi.com");
  assert.deepEqual((await res.json()).top, ["seo tips"]);
  assert.equal(counted, 1);
  await assert.rejects(handleYt(new Request("https://x/yt/suggest?q=seo", { method: "POST" }), env, null, "suggest", opts), { code: "not_found" });
  await assert.rejects(handleYt(new Request("https://x/yt/nothing"), env, null, "nothing", opts), { code: "not_found" });
});

test("median of views", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 3);
  assert.equal(median([]), null);
});

test("scale draws straight lines between points", () => {
  const pts = [[0, 0], [10, 50], [20, 100]];
  assert.equal(scale(5, pts), 25);
  assert.equal(scale(-1, pts), 0);
  assert.equal(scale(99, pts), 100);
  assert.equal(scale(null, pts), null);
});

test("health report: only uploads in the period, scores and tips", async (t) => {
  const day = 86400_000, now = Date.now();
  const ago = (d) => new Date(now - d * day).toISOString();
  // Ten uploads a week apart; the newer ones get more views. One is older than the 90 days asked for.
  const vids = {};
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const id = "v" + i;
    ids.push(id);
    vids[id] = { id, snippet: { title: "A good video title number " + i, publishedAt: ago(8 + i * 7), description: "0:00 Intro\nhttps://x.com #tag " + "word ".repeat(120), tags: ["a", "b", "c", "d", "e"], defaultAudioLanguage: "en" },
      statistics: { viewCount: String(2000 - i * 150), likeCount: "80", commentCount: "8" }, contentDetails: { duration: "PT8M", caption: "true" } };
  }
  vids.old = { id: "old", snippet: { title: "Old", publishedAt: ago(200) }, statistics: { viewCount: "5" }, contentDetails: { duration: "PT1M" } };
  const asked = [];
  const f = fakeFetch({
    "https://www.googleapis.com/youtube/v3/channels": { items: [{ id: "UC1", snippet: { title: "S", publishedAt: "2020-01-01T00:00:00Z" }, statistics: { subscriberCount: "10000", viewCount: "50000", videoCount: "11" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } }, brandingSettings: { channel: { keywords: "one two" } } }] },
    "https://www.googleapis.com/youtube/v3/playlistItems": { items: ids.concat("old").map((id) => ({ contentDetails: { videoId: id, videoPublishedAt: vids[id].snippet.publishedAt } })), nextPageToken: "P2" },
    "https://www.googleapis.com/youtube/v3/videos": (u) => { asked.push(u.searchParams.get("id")); return { items: u.searchParams.get("id").split(",").map((id) => vids[id]) }; },
  });
  t.mock.method(globalThis, "fetch", f);
  const r = await getReport(env, new URLSearchParams({ c: "UC_x5XG1OV2P6uZZ5FSM9Ttw", p: "90" }));
  assert.equal(r.period, "90");
  assert.equal(r.sample, 10);
  assert.equal(asked.length, 1, "stops paging once older uploads appear");
  assert.ok(!asked[0].includes("old"));
  assert.equal(r.capped, false);
  assert.equal(r.seo.chapters, 100);
  assert.equal(r.seo.tags, 100);
  assert.ok(r.momentum.change > 1, "newer videos do better");
  assert.ok(r.scores.momentum >= 80);
  assert.equal(r.reach, Math.round((r.medianViews / 10000) * 1000) / 10);
  assert.ok(r.overall > 0 && r.overall <= 100);
  assert.ok("ABCDF".includes(r.grade));
  assert.ok(r.tips.some((x) => x.code === "momentum_up"));
  assert.equal(r.uploads[0].id, "v0");
});

test("health report of a channel with no uploads in the period", () => {
  const c = { id: "UC1", snippet: { title: "S" }, statistics: { subscriberCount: "5", viewCount: "0", videoCount: "0" } };
  const r = healthReport(c, [], { period: "30", since: Date.now() - 30 * 86400_000, capped: false });
  assert.equal(r.sample, 0);
  assert.equal(r.scores.consistency, 0);
  assert.equal(r.tips[0].code, "no_uploads");
});

test("outliers score each upload against the channel's median, over two pages", async (t) => {
  const day = 86400_000;
  const page = (token) => (token ? { items: [{ contentDetails: { videoId: "c" } }] } : { items: [{ contentDetails: { videoId: "a" } }, { contentDetails: { videoId: "b" } }], nextPageToken: "P2" });
  const vids = {
    a: { id: "a", snippet: { title: "A", publishedAt: new Date(Date.now() - 10 * day).toISOString() }, statistics: { viewCount: "1000", likeCount: "50", commentCount: "5" }, contentDetails: { duration: "PT10M" } },
    b: { id: "b", snippet: { title: "B", publishedAt: new Date(Date.now() - 20 * day).toISOString() }, statistics: { viewCount: "100" }, contentDetails: { duration: "PT1M" } },
    c: { id: "c", snippet: { title: "C", publishedAt: new Date(Date.now() - 3600_000).toISOString() }, statistics: { viewCount: "200" } },
  };
  const f = fakeFetch({
    "https://www.googleapis.com/youtube/v3/channels": { items: [{ id: "UC1", snippet: { title: "S" }, statistics: { subscriberCount: "10", viewCount: "1300", videoCount: "3" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] },
    "https://www.googleapis.com/youtube/v3/playlistItems": (u) => page(u.searchParams.get("pageToken")),
    "https://www.googleapis.com/youtube/v3/videos": (u) => ({ items: u.searchParams.get("id").split(",").map((id) => vids[id]) }),
  });
  t.mock.method(globalThis, "fetch", f);
  const r = await getOutliers(env, new URLSearchParams({ c: "UC_x5XG1OV2P6uZZ5FSM9Ttw" }));
  assert.equal(r.sample, 3);
  assert.equal(r.medianViews, 200);
  const a = r.uploads.find((v) => v.id === "a");
  assert.equal(a.score, 5);
  assert.equal(a.perDay, 100);
  assert.equal(a.duration, 600);
  assert.equal(r.uploads.find((v) => v.id === "c").fresh, true);
});
