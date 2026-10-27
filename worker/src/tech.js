// Technology detection and known-vulnerable JavaScript libraries (from the Retire.js database in vulndb.json).
import VULNDB from "./vulndb.json";

// [name, category, test] where test gets {h: headers object, html, gen: generator meta, srcs: script and style URLs}.
// A test returns true, a version string, or nothing.
const FINGERPRINTS = [
  ["WordPress", "cms", ({ html, gen }) => ver(gen, /WordPress ?([\d.]+)?/i) || /\/wp-(content|includes)\//.test(html)],
  ["WooCommerce", "ecommerce", ({ html, gen }) => ver(gen, /WooCommerce ?([\d.]+)?/i) || /woocommerce/i.test(html)],
  ["Elementor", "cms", ({ html, gen }) => ver(gen, /Elementor ?([\d.]+)?/i) || /elementor-/.test(html)],
  ["Joomla", "cms", ({ gen, html }) => ver(gen, /Joomla!? ?([\d.]+)?/i) || /\/media\/jui\/|\/components\/com_/.test(html)],
  ["Drupal", "cms", ({ gen, h, html }) => ver(gen, /Drupal ?([\d.]+)?/i) || !!h["x-drupal-cache"] || /\/sites\/(default|all)\/files\//.test(html)],
  ["Shopify", "ecommerce", ({ h, html }) => !!h["x-shopify-stage"] || /cdn\.shopify\.com/.test(html)],
  ["Wix", "cms", ({ h, gen, html }) => !!h["x-wix-request-id"] || /Wix\.com/i.test(gen) || /static\.wixstatic\.com/.test(html)],
  ["Squarespace", "cms", ({ gen, html }) => /Squarespace/i.test(gen) || /static1\.squarespace\.com/.test(html)],
  ["Webflow", "cms", ({ gen, html }) => /Webflow/i.test(gen) || /data-wf-site=/.test(html)],
  ["Ghost", "cms", ({ gen }) => ver(gen, /Ghost ?([\d.]+)?/i)],
  ["Magento", "ecommerce", ({ html }) => /Mage\.Cookies|\/static\/version\d+\/frontend\//.test(html)],
  ["PrestaShop", "ecommerce", ({ gen, html }) => /PrestaShop/i.test(gen) || /prestashop/i.test(html)],
  ["Hugo", "ssg", ({ gen }) => ver(gen, /Hugo ?([\d.]+)?/i)],
  ["Jekyll", "ssg", ({ gen }) => ver(gen, /Jekyll v?([\d.]+)?/i)],
  ["Gatsby", "framework", ({ gen, html }) => ver(gen, /Gatsby ?([\d.]+)?/i) || /id="___gatsby"/.test(html)],
  ["Next.js", "framework", ({ h, html }) => /Next\.js/i.test(h["x-powered-by"] || "") || /__NEXT_DATA__|\/_next\/static\//.test(html)],
  ["Nuxt", "framework", ({ html }) => /__NUXT__|\/_nuxt\//.test(html)],
  ["Astro", "framework", ({ gen, html }) => ver(gen, /Astro v?([\d.]+)?/i) || /astro-island/.test(html)],
  ["Angular", "framework", ({ html }) => ver(html, /ng-version="([\d.]+)"/)],
  ["AngularJS", "framework", ({ html }) => /\sng-app[=\s>]/.test(html)],
  ["React", "framework", ({ html, srcs }) => /data-reactroot|__REACT_DEVTOOLS/.test(html) || srcs.some((s) => /react(-dom)?[.-]/.test(s))],
  ["Vue.js", "framework", ({ html, srcs }) => /\sdata-v-[0-9a-f]{6,8}[\s=>]|id="app" data-v-app/.test(html) || srcs.some((s) => /\/vue(@|\.|\/)/.test(s))],
  ["Svelte", "framework", ({ html }) => /class="[^"]*svelte-[a-z0-9]{5,}/.test(html)],
  ["Laravel", "framework", ({ h }) => /laravel_session/i.test(h["set-cookie-names"] || "")],
  ["PHP", "language", ({ h }) => ver(h["x-powered-by"], /PHP\/?([\d.]+)?/i) || /PHPSESSID/.test(h["set-cookie-names"] || "")],
  ["ASP.NET", "framework", ({ h }) => ver(h["x-aspnet-version"], /([\d.]+)/) || /ASP\.NET/i.test(h["x-powered-by"] || "") || /ASP\.NET_SessionId/.test(h["set-cookie-names"] || "")],
  ["Express", "framework", ({ h }) => /Express/i.test(h["x-powered-by"] || "")],
  ["nginx", "server", ({ h }) => ver(h.server, /nginx\/?([\d.]+)?/i)],
  ["Apache", "server", ({ h }) => ver(h.server, /Apache\/?([\d.]+)?/i)],
  ["Microsoft IIS", "server", ({ h }) => ver(h.server, /Microsoft-IIS\/?([\d.]+)?/i)],
  ["LiteSpeed", "server", ({ h }) => /LiteSpeed/i.test(h.server || "")],
  ["OpenResty", "server", ({ h }) => ver(h.server, /openresty\/?([\d.]+)?/i)],
  ["Caddy", "server", ({ h }) => /Caddy/i.test(h.server || "")],
  // Not cf-ray: a Worker's own outgoing requests can come back with one even from sites Cloudflare doesn't serve.
  ["Cloudflare", "cdn", ({ h }) => /^cloudflare/i.test(h.server || "")],
  ["Amazon CloudFront", "cdn", ({ h }) => !!h["x-amz-cf-id"]],
  ["Fastly", "cdn", ({ h }) => /fastly/i.test(h["x-served-by"] || "") || !!h["x-fastly-request-id"]],
  ["Akamai", "cdn", ({ h }) => /AkamaiGHost/i.test(h.server || "")],
  ["Vercel", "hosting", ({ h }) => !!h["x-vercel-id"]],
  ["Netlify", "hosting", ({ h }) => !!h["x-nf-request-id"] || /Netlify/i.test(h.server || "")],
  ["GitHub Pages", "hosting", ({ h }) => /GitHub\.com/i.test(h.server || "") || !!h["x-github-request-id"]],
  ["Bootstrap", "ui", ({ html, srcs }) => srcs.map((s) => ver(s, /bootstrap(?:@|\/|-)([\d.]+)/i)).find(Boolean) || srcs.some((s) => /bootstrap(\.min)?\.(css|js)/i.test(s)) || /class="[^"]*\b(container|row) [^"]*col-(sm|md|lg)-/.test(html)],
  ["Tailwind CSS", "ui", ({ html }) => /class="[^"]*\b(?:flex|grid) [^"]*\b(?:px|py|mt|mb)-\d/.test(html) && /class="[^"]*\b(?:text|bg)-(?:gray|slate|zinc)-\d{3}/.test(html)],
  ["Font Awesome", "ui", ({ srcs }) => srcs.some((s) => /font-?awesome/i.test(s))],
  ["Google Analytics", "analytics", ({ html }) => /googletagmanager\.com\/gtag\/js|google-analytics\.com\/(analytics|ga)\.js/.test(html)],
  ["Google Tag Manager", "analytics", ({ html }) => /googletagmanager\.com\/gtm\.js/.test(html)],
  ["Meta Pixel", "analytics", ({ html }) => /connect\.facebook\.net\/[^"']*\/fbevents\.js/.test(html)],
  ["Hotjar", "analytics", ({ html }) => /static\.hotjar\.com/.test(html)],
  ["reCAPTCHA", "security", ({ html }) => /google\.com\/recaptcha|recaptcha\/api\.js/.test(html)],
  ["Cloudflare Turnstile", "security", ({ html }) => /challenges\.cloudflare\.com\/turnstile/.test(html)],
];

function ver(s, re) {
  if (!s) return undefined;
  const m = String(s).match(re);
  if (!m) return undefined;
  return m[1] || true;
}

export function detectTech({ headers, html, generator, srcs, cookieNames }) {
  const h = { ...headers, "set-cookie-names": cookieNames.join(" ") };
  const ctx = { h, html, gen: generator || "", srcs };
  const found = [];
  for (const [name, cat, test] of FINGERPRINTS) {
    let r;
    try { r = test(ctx); } catch { r = undefined; }
    if (r) found.push({ name, cat, version: typeof r === "string" ? r : null });
  }
  return found;
}

// ----- Vulnerable libraries -----

const reCache = new Map();
function rx(pattern) {
  if (!reCache.has(pattern)) {
    // Retire marks where the version is with §§version§§; capture it.
    let re = null;
    try { re = new RegExp(pattern.replace(/§§version§§/g, "([0-9][0-9a-zA-Z._\\-]*)"), "i"); } catch { /* skip bad pattern */ }
    reCache.set(pattern, re);
  }
  return reCache.get(pattern);
}

function cleanVersion(v) {
  const m = v.match(/^\d+(?:\.\d+)*(?:-(?:alpha|beta|rc)[.\d]*)?/i);
  return m ? m[0] : null;
}

function firstMatch(patterns, text) {
  for (const p of patterns) {
    const re = rx(p);
    if (!re) continue;
    const m = text.match(re);
    if (m && m[1]) return cleanVersion(m[1]);
  }
  return null;
}

// Common names used in file paths; used to spot WordPress-style "jquery.min.js?ver=3.6.0" and to pick files to read.
const FILE_NAMES = {
  jquery: /\/jquery(\.min)?\.js/i,
  "jquery-ui": /\/jquery-ui(\.min)?\.js|\/jquery\/ui\/core(\.min)?\.js/i,
  "jquery-migrate": /\/jquery-migrate(\.min)?\.js/i,
  bootstrap: /\/bootstrap(\.bundle)?(\.min)?\.js/i,
  angularjs: /\/angular(\.min)?\.js/i,
  "moment.js": /\/moment(\.min)?\.js/i,
  lodash: /\/lodash(\.min)?\.js/i,
  "underscore.js": /\/underscore(\.min)?\.js/i,
  handlebars: /\/handlebars(\.min)?\.js/i,
  vue: /\/vue(\.min|\.global|\.runtime)?(\.prod)?\.js/i,
  DOMPurify: /\/purify(\.min)?\.js/i,
  "prototypejs": /\/prototype(\.min)?\.js/i,
};

export function libsFromUrls(srcs) {
  const found = new Map();
  const unknown = [];
  for (const src of srcs) {
    let hit = false;
    const fname = src.split("?")[0].split("/").pop();
    for (const [name, lib] of Object.entries(VULNDB)) {
      const v = firstMatch(lib.uri, src) || firstMatch(lib.filename, fname);
      if (v) { found.set(name, { name, version: v, src }); hit = true; break; }
    }
    if (hit) continue;
    for (const [name, re] of Object.entries(FILE_NAMES)) {
      if (!re.test(src)) continue;
      const q = src.match(/[?&]ver(?:sion)?=(\d+(?:\.\d+){1,3})/);
      if (q && VULNDB[name]) found.set(name, { name, version: q[1], src });
      else unknown.push(src);
      break;
    }
  }
  return { found, unknown };
}

export function libsFromContent(text, src) {
  for (const [name, lib] of Object.entries(VULNDB)) {
    if (!lib.filecontent.length) continue;
    const v = firstMatch(lib.filecontent, text);
    if (v) return { name, version: v, src };
  }
  return null;
}

function cmp(a, b) {
  const pa = String(a).split(/[.-]/), pb = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0", y = pb[i] ?? "0";
    const nx = parseInt(x, 10), ny = parseInt(y, 10);
    if (!isNaN(nx) && !isNaN(ny) && nx !== ny) return nx - ny;
    if (isNaN(nx) !== isNaN(ny)) return isNaN(nx) ? -1 : 1; // 1.0.0-beta < 1.0.0
    if (isNaN(nx) && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
export const compareVersions = cmp;

export function vulnsFor(name, version) {
  const lib = VULNDB[name];
  if (!lib || !version) return [];
  return lib.vulns.filter((v) => (!v.atOrAbove || cmp(version, v.atOrAbove) >= 0) && (!v.below || cmp(version, v.below) < 0));
}
