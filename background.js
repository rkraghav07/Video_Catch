// Video Catch — background service worker (MV3)
// Detects media via network sniffing + content-script reports, tracks it per tab,
// and shows a notification prompt asking whether to download.

const mediaByTab = new Map(); // tabId -> [ entry, ... ]
const notifMap = new Map();   // notificationId -> entry (for prompt buttons)
const tabPrompted = new Set(); // tabs already prompted this page session
const tabPending = new Map();  // tabId -> { timer, best } debounce state
const canceledIds = new Set(); // ids the user canceled — drop any late blob for them
const restartingIds = new Set(); // ids mid-retry — swallow the OLD attempt's terminal msgs

let settings = {
  autoPrompt: true,
  askLocation: false,
  subfolder: "", // relative folder under the Downloads dir (e.g. "Video Catch")
  speed: "fast",
  convertMp4: true,
  overlayButton: true,
  skipAds: true, // skip YouTube ads during capture so they aren't recorded
  captureMp4: true, // force H.264/AAC on YouTube so captures save as .mp4 (not .mkv)
};

// Prefix the filename with the user's default subfolder (under Downloads).
// Absolute paths aren't allowed by the downloads API — only relative subfolders.
function withFolder(name) {
  const f = (settings.subfolder || "")
    .trim()
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return f ? `${f}/${name}` : name;
}

// Per-download segment concurrency. The global fetch semaphore (offscreen.js,
// MAX_GLOBAL_FETCHES) is the real socket-explosion guard, so these can be generous:
// a single turbo download saturates all 16 global slots (fast), while several
// downloads together are still capped at 16 total sockets (safe).
const SPEED_TO_CONCURRENCY = { normal: 8, fast: 16, turbo: 30 };
const ACCEL_MAX_BYTES = 800 * 1024 * 1024; // don't hold >800MB in memory; use normal download

function concurrency() {
  return SPEED_TO_CONCURRENCY[settings.speed] || 16;
}

// Downloads history/progress, surfaced in the popup's "Downloads" tab.
let downloads = []; // [{ id, name, type, status, progress, error, time }]

// Resolves once settings + downloads are loaded from storage. Download actions
// await this so an event that wakes the worker can't run with default settings.
let initDone;
const initReady = new Promise((res) => (initDone = res));
let initFinished = false;
initReady.then(() => (initFinished = true));

// Re-attach a completion listener to a browser-managed download that survived a
// service-worker restart (the original onChanged listener died with the worker).
function watchBrowserDownload(rec) {
  const dlId = rec.dlId;
  const onChanged = (delta) => {
    if (delta.id !== dlId || !delta.state) return;
    if (delta.state.current === "complete") {
      chrome.downloads.onChanged.removeListener(onChanged);
      patchDownload(rec.id, { status: "completed", progress: 100 });
    } else if (delta.state.current === "interrupted") {
      chrome.downloads.onChanged.removeListener(onChanged);
      patchDownload(rec.id, { status: "failed", error: "interrupted" });
    }
  };
  chrome.downloads.onChanged.addListener(onChanged);
}

chrome.storage.local.get(["settings", "downloads"]).then(async (r) => {
  if (r.settings) settings = { ...settings, ...r.settings };
  if (r.downloads) {
    downloads = r.downloads;
    const active = downloads.filter((d) => d.status === "downloading" || d.status === "paused");
    if (active.length) {
      // The offscreen document OUTLIVES this service worker, so a job that looks
      // "left over" may still be running (or paused) there. Blanket-failing them
      // meant handleHlsReady later discarded the finished blob (status was
      // "failed"). Ask the offscreen doc which ids are live and only fail the
      // truly dead ones.
      let liveIds = [];
      try {
        if (await chrome.offscreen.hasDocument()) {
          const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "list-jobs" });
          if (res && Array.isArray(res.ids)) liveIds = res.ids;
        }
      } catch {}
      for (const d of active) {
        if (liveIds.includes(d.id)) {
          hlsJobs.set(d.id, d.req || { id: d.id, tabId: null });
          continue; // still alive in the offscreen doc — leave it running
        }
        if (d.dlId != null) {
          // Browser-managed download — check its real state instead of guessing.
          try {
            const found = await new Promise((res2) =>
              chrome.downloads.search({ id: d.dlId }, (x) => res2(!chrome.runtime.lastError && x && x[0]))
            );
            if (found && found.state === "complete") {
              Object.assign(d, { status: "completed", progress: 100, phase: null });
              continue;
            }
            if (found && found.state === "in_progress") {
              watchBrowserDownload(d);
              continue;
            }
          } catch {}
        }
        Object.assign(d, { status: "failed", error: "interrupted", phase: null, dlId: null });
      }
      persistDownloads();
    }
  }
  initDone();
});

function persistDownloads() {
  chrome.storage.local.set({ downloads });
}

function broadcastDownloads() {
  chrome.runtime.sendMessage({ type: "downloads-update", downloads }).catch(() => {});
}

function pushDownload(rec) {
  const existing = downloads.find((d) => d.id === rec.id);
  if (existing) {
    Object.assign(existing, rec);
  } else {
    rec.time = Date.now();
    downloads.unshift(rec);
    // Cap the history at 50 — but never evict an ACTIVE record (dropping one
    // makes handleHlsReady treat its finished blob as canceled and discard it).
    if (downloads.length > 50) {
      for (let i = downloads.length - 1; i >= 0 && downloads.length > 50; i--) {
        const d = downloads[i];
        if (d.status !== "downloading" && d.status !== "paused") downloads.splice(i, 1);
      }
    }
  }
  if (rec.status === "completed") markSaved();
  broadcastDownloads();
  persistDownloads();
}

function patchDownload(id, patch) {
  const r = downloads.find((d) => d.id === id);
  if (!r) return;
  Object.assign(r, patch);
  if (patch.status === "completed") markSaved();
  broadcastDownloads();
  if (patch.status) persistDownloads();
}
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings && changes.settings.newValue) {
    settings = { ...settings, ...changes.settings.newValue };
  }
});

// --- detection helpers -----------------------------------------------------

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|avi|flv|m3u8|mpd|ts)(\?|#|$)/i;

function classify(url, contentType) {
  if (/m3u8/i.test(url) || (contentType && /mpegurl/i.test(contentType))) return "hls";
  if (/\.mpd(\?|#|$)/i.test(url) || (contentType && /dash\+xml/i.test(contentType))) return "dash";
  return "video";
}

function shortName(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(last).slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}

// --- "Paste a link" resolver -----------------------------------------------
// Takes any URL the user pastes and returns downloadable candidates. Works for
// the easy 90% of the web (direct files, HLS/DASH, and pages that expose the
// media URL via og:video / <video> / JSON). YouTube is special-cased: it's
// SABR-locked, so there's no grabbable URL — we route the user to Capture mode.

const AUDIO_EXT = /\.(mp3|m4a|aac|opus|ogg|wav|flac)(\?|#|$)/i;

function isYouTubeUrl(u) {
  return /(^|\.)youtube\.com$/i.test(u.hostname) || /(^|\.)youtu\.be$/i.test(u.hostname) ||
    /(^|\.)youtube-nocookie\.com$/i.test(u.hostname);
}

function mkEntry(url, type, tabId, meta = {}) {
  return {
    id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    tabId: tabId == null ? -1 : tabId,
    type,
    source: "paste",
    url,
    title: meta.title || null,
    size: meta.size || null,
    contentType: meta.contentType || null,
    poster: meta.poster || null,
  };
}

// HEAD the URL to learn its type/size without downloading the body.
async function probeUrl(url) {
  try {
    const r = await fetch(url, { method: "HEAD", credentials: "include" });
    const ct = r.headers.get("content-type") || "";
    const len = parseInt(r.headers.get("content-length") || "", 10);
    return { contentType: ct, size: isFinite(len) ? len : null, ok: r.ok };
  } catch {
    return { contentType: "", size: null, ok: false };
  }
}

function rankEntry(e) {
  return e.type === "hls" ? 3 : e.type === "dash" ? 2 : 1;
}

// Scrape a page's HTML for video/stream URLs.
function extractMediaFromHtml(html, baseUrl, tabId) {
  const found = new Map(); // absolute url -> type
  const abs = (s) => {
    try {
      return new URL(
        (s || "").replace(/&amp;/g, "&").replace(/\\\//g, "/").replace(/\\+$/, "").trim(),
        baseUrl
      ).href;
    } catch {
      return null;
    }
  };
  const add = (raw, type) => {
    const url = abs(raw);
    if (!url || !/^https?:/i.test(url) || url.startsWith("data:")) return;
    // upgrade type if we already have it as a plain video but now know it's a stream
    if (!found.has(url) || rankEntry({ type }) > rankEntry({ type: found.get(url) })) found.set(url, type);
  };
  let m;
  // og:video / twitter:player:stream (content can come before or after the property)
  const metaA = /<meta[^>]+(?:property|name)=["'](?:og:video(?::(?:url|secure_url))?|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi;
  while ((m = metaA.exec(html))) add(m[1], /\.m3u8/i.test(m[1]) ? "hls" : "video");
  const metaB = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video(?::(?:url|secure_url))?|twitter:player:stream)["']/gi;
  while ((m = metaB.exec(html))) add(m[1], /\.m3u8/i.test(m[1]) ? "hls" : "video");
  // <video src> / <source src>
  const srcRe = /<(?:video|source)[^>]+src=["']([^"']+)["']/gi;
  while ((m = srcRe.exec(html))) {
    const u = m[1];
    add(u, /\.m3u8/i.test(u) ? "hls" : /\.mpd/i.test(u) ? "dash" : "video");
  }
  // Common JSON keys that hold a media URL (Instagram/Facebook "video_url",
  // many players' "playbackUrl"/"hlsUrl"/"streamUrl"/"manifestUrl", JSON-LD
  // "contentUrl"). Captures the value, types it by extension.
  const jsonKeyRe =
    /"(?:contenturl|video_url|videourl|playbackurl|playback_url|hlsurl|hls_url|hlsmanifesturl|dashurl|dash_url|manifesturl|streamurl|stream_url|playurl|play_url|downloadurl|download_url|src|file|url)"\s*:\s*"([^"]+?\.(?:m3u8|mpd|mp4|webm|m4v|mov)(?:\\?[?#][^"]*)?)"/gi;
  while ((m = jsonKeyRe.exec(html))) {
    const u = m[1];
    add(u, /\.m3u8/i.test(u) ? "hls" : /\.mpd/i.test(u) ? "dash" : "video");
  }
  // Instagram/Facebook "video_versions" arrays and any nested "url" near them are
  // covered by the bare-URL sweep below; this catches keys without an extension
  // hint only when the value clearly looks like a stream.
  // Bare media URLs anywhere (handles escaped slashes in JSON blobs)
  const bareRe = /https?:\\?\/\\?\/[^\s"'<>]+?\.(m3u8|mpd|mp4|webm|m4v|mov)(?:[?#][^\s"'<>]*)?/gi;
  while ((m = bareRe.exec(html))) {
    const ext = m[1].toLowerCase();
    add(m[0], ext === "m3u8" ? "hls" : ext === "mpd" ? "dash" : "video");
  }
  // Page title for nicer filenames
  let title = null;
  const tm =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (tm) title = tm[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();

  // Poster/thumbnail (og:image) — offered as a "grab thumbnail" button.
  let poster = null;
  const pm =
    html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::url)?|twitter:image)["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::url)?|twitter:image)["']/i);
  if (pm) {
    try {
      poster = new URL(pm[1].replace(/&amp;/g, "&"), baseUrl).href;
    } catch {}
  }

  const items = [...found].map(([url, type]) => mkEntry(url, type, tabId, { title, poster }));
  items.sort((a, b) => rankEntry(b) - rankEntry(a));
  return items.slice(0, 8);
}

const IG_APP_ID = "936619743392459"; // public Instagram web App-ID (how download sites auth)

// Instagram shortcode → numeric media id. Shortcodes are base64 (this alphabet)
// of the media's primary key; the /media/{id}/info/ endpoint takes that id.
function igShortcodeToMediaId(code) {
  const AB = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let id = 0n;
  for (const c of code) {
    const idx = AB.indexOf(c);
    if (idx < 0) return null;
    id = id * 64n + BigInt(idx);
  }
  return id.toString();
}

// Collect the best progressive MP4 URL from an IG media item (recurses into
// carousel/album children). Instagram lists video_versions highest-quality first.
function igCollectVideos(item, acc) {
  if (!item) return;
  const kids = item.carousel_media;
  if (Array.isArray(kids)) {
    kids.forEach((k) => igCollectVideos(k, acc));
    return;
  }
  const vv = item.video_versions;
  if (Array.isArray(vv) && vv.length && vv[0].url) acc.push(vv[0].url);
}

// Instagram posts / reels / IGTV. The old ?__a=1 endpoint is dead (returns a
// 404 login page as of 2026), so we now do what current download tools do:
// derive the media id from the shortcode and hit the mobile /media/{id}/info/
// API with the public web App-ID + your session cookies. video_versions[].url
// is a directly downloadable progressive MP4 (byte-range capable).
async function resolveInstagram(u, tabId) {
  const m = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(u.pathname);
  if (!m) return null;
  const mediaId = igShortcodeToMediaId(m[1]);
  if (!mediaId) return null;

  let urls = [];
  let title = null;
  try {
    const r = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
      credentials: "include",
      headers: { "X-IG-App-ID": IG_APP_ID },
    });
    if (r.ok) {
      const j = await r.json();
      const item = j && j.items && j.items[0];
      if (item) {
        if (item.caption && item.caption.text) title = item.caption.text.replace(/\s+/g, " ").trim().slice(0, 60);
        const acc = [];
        igCollectVideos(item, acc);
        // de-dupe (a video can appear at multiple ids across carousel edge cases)
        urls = [...new Set(acc)];
      }
    }
  } catch {}

  if (!urls.length) return null;
  const items = urls.map((url, i) =>
    mkEntry(url, "video", tabId, { title: title || `Instagram video${urls.length > 1 ? " " + (i + 1) : ""}` })
  );
  return items.slice(0, 10);
}

// Instagram Stories / Highlights. Different from posts: the media isn't in the
// page HTML or the post API — it's behind the login-only reels_media feed, keyed
// by the user's NUMERIC id (or a highlight id), so we resolve the id first, then
// pull the story reel with the public web App-ID + the user's session cookies.
// Best-effort: only works while signed in and only for stories you can view.
async function resolveInstagramStory(u, tabId) {
  const m = /\/stories\/([^/?#]+)(?:\/(\d+))?/.exec(u.pathname);
  if (!m) return null;
  const owner = m[1];
  const wantPk = m[2] || null; // a specific story item, if the URL names one
  const IG_APP = { "X-IG-App-ID": IG_APP_ID };

  // Figure out the reel id to request.
  let reelId = null;
  if (owner === "highlights" && wantPk) {
    reelId = "highlight:" + wantPk;
  } else {
    // username → numeric user id via the public web-profile endpoint.
    try {
      const r = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(owner)}`,
        { credentials: "include", headers: IG_APP }
      );
      if (r.ok) {
        const j = await r.json();
        reelId = j && j.data && j.data.user && j.data.user.id;
      }
    } catch {}
  }
  if (!reelId) {
    return {
      ok: false,
      message:
        "Couldn't open that story. Make sure you're logged in to Instagram in this browser and can view the story, then try again.",
    };
  }

  // Fetch the reel media (try www then i.instagram.com) and parse video_versions.
  const hosts = ["https://www.instagram.com", "https://i.instagram.com"];
  for (const host of hosts) {
    try {
      const r = await fetch(`${host}/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`, {
        credentials: "include",
        headers: IG_APP,
      });
      if (!r.ok) continue;
      const j = await r.json();
      const reel = (j.reels && (j.reels[reelId] || j.reels[String(reelId)])) || (j.reels_media && j.reels_media[0]);
      const storyItems = (reel && reel.items) || [];
      // Name the file after the person whose story it is (the URL username, or the
      // reel owner's username for highlights).
      const ownerName =
        (reel && reel.user && reel.user.username) || (owner !== "highlights" ? owner : "instagram");
      const pick = (filterToPk) => {
        const acc = [];
        for (const it of storyItems) {
          if (filterToPk && String(it.pk) !== String(wantPk) && String(it.id || "").split("_")[0] !== String(wantPk)) continue;
          if (Array.isArray(it.video_versions) && it.video_versions.length) acc.push(it.video_versions[0].url);
        }
        return [...new Set(acc)];
      };
      // Prefer the specific story named in the URL; if that matches nothing, take all.
      let urls = wantPk ? pick(true) : [];
      if (!urls.length) urls = pick(false);
      if (urls.length) {
        const items = urls.map((url, i) =>
          mkEntry(url, "video", tabId, { title: `${ownerName} story${urls.length > 1 ? " " + (i + 1) : ""}` })
        );
        return { ok: true, items: items.slice(0, 20) };
      }
      // Reel resolved but no video (image-only stories) — say so clearly.
      return {
        ok: false,
        message: "No video in that story — it looks image-only (or has expired).",
      };
    } catch {}
  }
  return {
    ok: false,
    message: "Couldn't fetch that story (Instagram may be rate-limiting — try again in a moment).",
  };
}

// Pasted Reddit link → a Reddit entry with the media id + the real post title
// (a plain scrape only finds the generic "Reddit - The heart of the internet").
// A v.redd.it URL carries the id directly; a post URL is fetched and mined for it.
async function resolveRedditLink(u, tabId) {
  let id = null;
  let title = null;
  if (/(^|\.)v\.redd\.it$/i.test(u.hostname)) {
    id = (u.pathname.match(/^\/([A-Za-z0-9]+)/) || [])[1];
  } else if (/(^|\.)reddit\.com$/i.test(u.hostname) || /(^|\.)redd\.it$/i.test(u.hostname)) {
    let html;
    try {
      html = await (await fetch(u.href, { credentials: "include" })).text();
    } catch {
      return null;
    }
    id = (html.match(/v\.redd\.it\\?\/([A-Za-z0-9]+)/i) || [])[1];
    title =
      (html.match(/post-title="([^"]+)"/i) || [])[1] ||
      (html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1] ||
      (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
    if (title) title = decodeEntities(title).replace(/\s*:\s*r\/[A-Za-z0-9_]+\s*$/i, "").trim();
  }
  if (!id) return null;
  return {
    ok: true,
    items: [
      {
        id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        tabId: tabId == null ? -1 : tabId,
        type: "video",
        source: "reddit",
        url: `https://v.redd.it/${id}/DASHPlaylist.mpd`,
        redditId: id,
        title: title || "reddit-video",
        poster: null,
        size: null,
      },
    ],
  };
}

async function resolveLink(rawUrl, tabId) {
  let url = (rawUrl || "").trim();
  if (!url) return { ok: false, message: "Paste a video link or page URL first." };
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, message: "That doesn't look like a valid URL." };
  }

  if (isYouTubeUrl(u)) {
    return {
      ok: false,
      youtube: true,
      url: u.href,
      message:
        "YouTube blocks direct downloads (SABR). Open the video in a tab and use “Capture full video” — it's the only thing that works locally.",
    };
  }

  // Instagram hides the video URL behind its JSON API, not the page HTML — so a
  // plain scrape fails. Resolve it the way download sites do: hit Instagram's own
  // media endpoint with the public web App-ID (your logged-in cookies go too, so
  // it also works for content only you can see).
  if (/(^|\.)instagram\.com$/i.test(u.hostname)) {
    // Stories/highlights use a separate login-only reels_media API — handle first.
    if (/\/stories\//i.test(u.pathname)) {
      const st = await resolveInstagramStory(u, tabId);
      if (st) return st;
    }
    const ig = await resolveInstagram(u, tabId);
    if (ig && ig.length) return { ok: true, items: ig };
    return {
      ok: false,
      message:
        "Couldn't fetch that Instagram video (it may be private, a story, or login-gated). Try opening the post and playing it, then download from the popup.",
    };
  }

  // Reddit: resolve the media id + real post title (a plain scrape only finds the
  // generic site title), then let doDownload fetch the CMAF video + audio.
  if (/(^|\.)reddit\.com$/i.test(u.hostname) || /(^|\.)redd\.it$/i.test(u.hostname) || /(^|\.)v\.redd\.it$/i.test(u.hostname)) {
    const rd = await resolveRedditLink(u, tabId);
    if (rd) return rd;
  }

  // Direct subtitle file — offer format choices instead of a "download".
  if (/\.(srt|vtt|ttml|srv\d)(\?|#|$)/i.test(u.pathname)) {
    return { ok: true, subtitle: true, url: u.href, title: shortName(u.href).replace(/\.[^.]+$/, "") };
  }

  // Direct stream/file by extension — no page fetch needed.
  if (/\.m3u8(\?|#|$)/i.test(u.pathname)) return { ok: true, items: [mkEntry(u.href, "hls", tabId)] };
  if (/\.mpd(\?|#|$)/i.test(u.pathname)) return { ok: true, items: [mkEntry(u.href, "dash", tabId)] };
  if (VIDEO_EXT.test(u.pathname) || AUDIO_EXT.test(u.pathname)) {
    const meta = await probeUrl(u.href);
    const type = /mpegurl/i.test(meta.contentType) ? "hls" : "video";
    return { ok: true, items: [mkEntry(u.href, type, tabId, meta)] };
  }

  // Otherwise fetch the page and scrape it.
  let html;
  try {
    const r = await fetch(u.href, { credentials: "include" });
    const ct = r.headers.get("content-type") || "";
    if (/^(video|audio)\//i.test(ct)) {
      const len = parseInt(r.headers.get("content-length") || "", 10);
      return { ok: true, items: [mkEntry(u.href, "video", tabId, { contentType: ct, size: isFinite(len) ? len : null })] };
    }
    if (/mpegurl/i.test(ct)) return { ok: true, items: [mkEntry(u.href, "hls", tabId)] };
    if (/dash\+xml/i.test(ct)) return { ok: true, items: [mkEntry(u.href, "dash", tabId)] };
    html = await r.text();
  } catch {
    return { ok: false, message: "Couldn't load that page (it may block cross-origin access). Try the direct video file URL." };
  }

  const items = extractMediaFromHtml(html, u.href, tabId);
  if (!items.length) {
    return {
      ok: false,
      message: "No video found on that page. Tip: right-click the video → “Copy video address”, then paste that.",
    };
  }
  return { ok: true, items };
}

// --- Subtitles / transcripts -----------------------------------------------
// Download captions as .srt / .vtt, or a clean plain-text transcript. Sources:
// YouTube (any language the video offers, incl. auto-captions, plus on-the-fly
// translation), HLS subtitle tracks (#EXT-X-MEDIA:TYPE=SUBTITLES), and direct
// .srt/.vtt/.ttml URLs. All parsing is pure JS — no ffmpeg/offscreen needed;
// the file is saved straight from a data: URL.

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // fromCodePoint, not fromCharCode — astral codepoints (emoji, &#128512;)
    // otherwise decode to garbage surrogate halves.
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(+n); } catch { return ""; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ""; }
    });
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, "");
}

// "HH:MM:SS.mmm" / "MM:SS,mmm" / "SS.mmm" → seconds
function parseCueTime(t) {
  const parts = String(t).trim().replace(",", ".").split(":").map(parseFloat);
  let s = 0;
  for (const p of parts) s = s * 60 + (isFinite(p) ? p : 0);
  return s;
}

function fmtCueTime(sec, sep) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

// WebVTT (and SubRip — same block layout, comma in timestamps) → cue list.
function parseVtt(text) {
  const cues = [];
  text = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split("\n");
    const tIdx = lines.findIndex((l) => l.includes("-->"));
    if (tIdx === -1) continue;
    const mt = lines[tIdx].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!mt) continue;
    const textLines = lines
      .slice(tIdx + 1)
      .map((l) => stripTags(decodeEntities(l)).trim())
      .filter((l) => l.length);
    const t = textLines.join("\n").trim();
    if (t) cues.push({ start: parseCueTime(mt[1]), end: parseCueTime(mt[2]), text: t });
  }
  return cues;
}

// YouTube srv1 (<text start dur>) and TTML (<p begin end>) timed XML.
function parseTimedXml(text) {
  const cues = [];
  let m;
  const reA = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/gi;
  while ((m = reA.exec(text))) {
    const start = parseFloat(m[1]) || 0;
    const dur = parseFloat(m[2]);
    const t = stripTags(decodeEntities(m[3].replace(/\n/g, " "))).trim();
    if (t) cues.push({ start, end: start + (isFinite(dur) ? dur : 2), text: t });
  }
  if (cues.length) return cues;
  const reB = /<p[^>]*\bbegin="([\d:.,]+)"[^>]*\bend="([\d:.,]+)"[^>]*>([\s\S]*?)<\/p>/gi;
  while ((m = reB.exec(text))) {
    const t = stripTags(decodeEntities(m[3].replace(/<br\s*\/?>/gi, "\n"))).trim();
    if (t) cues.push({ start: parseCueTime(m[1]), end: parseCueTime(m[2]), text: t });
  }
  if (cues.length) return cues;
  // YouTube srv3: <p t="ms" d="ms"><s>word</s>…> (t/d are milliseconds).
  const reC = /<p\b[^>]*\bt="(\d+)"(?:[^>]*\bd="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi;
  while ((m = reC.exec(text))) {
    const start = (parseInt(m[1], 10) || 0) / 1000;
    const dur = m[2] ? parseInt(m[2], 10) / 1000 : NaN;
    const t = stripTags(decodeEntities(m[3].replace(/<br\s*\/?>/gi, "\n"))).trim();
    if (t) cues.push({ start, end: start + (isFinite(dur) ? dur : 2), text: t });
  }
  return cues;
}

// YouTube json3 (the format the player itself requests): { events: [ { tStartMs,
// dDurationMs, segs: [{utf8}] } ] }. This is what we capture from the player.
function parseJson3(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!data || !Array.isArray(data.events)) return [];
  const cues = [];
  for (const e of data.events) {
    if (!e || !Array.isArray(e.segs)) continue;
    const t = e.segs
      .map((s) => (s && s.utf8) || "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!t) continue;
    const start = (e.tStartMs || 0) / 1000;
    const dur = (e.dDurationMs || 0) / 1000;
    cues.push({ start, end: start + (dur || 2), text: t });
  }
  return cues;
}

function parseSubtitles(text, hint) {
  const head = text.slice(0, 200).toLowerCase();
  if (hint === "json3" || (/^\s*\{/.test(text) && /"events"\s*:/.test(head + text.slice(0, 400)))) {
    const j = parseJson3(text);
    if (j.length) return j;
  }
  if (hint === "vtt" || /^\s*﻿?webvtt/.test(head)) return parseVtt(text);
  if (hint === "xml" || hint === "ttml" || /<(?:text|tt|tbody|p|timedtext)\b/i.test(head)) {
    const x = parseTimedXml(text);
    if (x.length) return x;
  }
  if (/-->/.test(text)) return parseVtt(text);
  return parseTimedXml(text);
}

function cuesToSrt(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${fmtCueTime(c.start, ",")} --> ${fmtCueTime(c.end, ",")}\n${c.text}\n`)
    .join("\n");
}

function cuesToVtt(cues) {
  return (
    "WEBVTT\n\n" +
    cues.map((c) => `${fmtCueTime(c.start, ".")} --> ${fmtCueTime(c.end, ".")}\n${c.text}\n`).join("\n")
  );
}

// Plain transcript. YouTube auto-captions roll the caption window — each cue
// repeats the previous line(s) then appends a word or two. Collapse those so the
// transcript reads as clean prose instead of every word three times.
function cuesToTxt(cues) {
  const out = [];
  let last = "";
  for (const c of cues) {
    const line = c.text.replace(/\s+/g, " ").trim();
    if (!line || line === last) continue;
    if (last && line.startsWith(last)) {
      out[out.length - 1] = line; // rolling caption grew — replace the partial
    } else if (last && last.startsWith(line)) {
      // a shorter subset of the previous line — skip
    } else {
      out.push(line);
    }
    last = line;
  }
  return out.join("\n") + "\n";
}

function convertSubs(text, fromHint, format) {
  const cues = parseSubtitles(text, fromHint);
  if (!cues.length) return null;
  if (format === "vtt") return { ext: "vtt", mime: "text/vtt", data: cuesToVtt(cues) };
  if (format === "txt") return { ext: "txt", mime: "text/plain", data: cuesToTxt(cues) };
  return { ext: "srt", mime: "application/x-subrip", data: cuesToSrt(cues) };
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

// Save a text file (subtitle/transcript) straight from a data: URL — no blob URL
// (unavailable in the MV3 service worker) and no offscreen doc needed.
function saveTextFile(name, mime, data) {
  return new Promise((resolve) => {
    const url = `data:${mime};charset=utf-8;base64,${utf8ToB64(data)}`;
    chrome.downloads.download({ url, filename: withFolder(name), saveAs: !!settings.askLocation }, (dlId) => {
      resolve({
        dlId: dlId == null ? null : dlId,
        error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null,
      });
    });
  });
}

function subExt(url) {
  const m = /\.(vtt|srt|ttml|xml|srv\d)(\?|#|$)/i.exec(url || "");
  return m ? m[1].toLowerCase().replace(/^srv\d$/, "xml") : "";
}

// Bracket-match a JSON array value out of a blob (e.g. ytInitialPlayerResponse),
// respecting strings/escapes — cheaper and safer than a greedy regex.
function extractJsonArray(src, key) {
  const at = src.indexOf(`"${key}":`);
  if (at === -1) return null;
  const i = src.indexOf("[", at);
  if (i === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return src.slice(i, j + 1);
  }
  return null;
}

function ytName(n, fallback) {
  if (!n) return fallback;
  return n.simpleText || (n.runs && n.runs.map((r) => r.text).join("")) || fallback;
}

// YouTube captions aren't SABR-locked (unlike the video) — captionTracks live in
// the watch page's ytInitialPlayerResponse with directly fetchable baseUrls.
async function resolveYouTubeSubs(videoId) {
  if (!videoId) return { ok: false, message: "No YouTube video detected on this tab." };
  let html;
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, { credentials: "include" });
    html = await r.text();
  } catch {
    return { ok: false, message: "Couldn't load the video page." };
  }
  const arr = extractJsonArray(html, "captionTracks");
  if (!arr) return { ok: false, message: "No captions/subtitles available for this video." };
  let raw;
  try {
    raw = JSON.parse(arr); // JSON.parse already decodes & and \/
  } catch {
    return { ok: false, message: "Couldn't read the caption list." };
  }
  const tracks = raw
    .filter((t) => t && t.baseUrl)
    .map((t, i) => ({
      id: "yt-" + i,
      url: t.baseUrl,
      lang: t.languageCode || "",
      label: ytName(t.name, t.languageCode || "Track " + (i + 1)),
      kind: t.kind === "asr" ? "auto" : "",
      translatable: t.isTranslatable !== false,
      youtube: true,
    }));
  if (!tracks.length) return { ok: false, message: "No captions/subtitles available for this video." };

  let translation = [];
  const tlArr = extractJsonArray(html, "translationLanguages");
  if (tlArr) {
    try {
      translation = JSON.parse(tlArr)
        .map((l) => ({ code: l.languageCode, name: ytName(l.languageName, l.languageCode) }))
        .filter((l) => l.code);
    } catch {}
  }
  return { ok: true, tracks, translation };
}

// HLS subtitle tracks declared in the master playlist. Each points to a sub
// playlist whose segments are WebVTT — fetch + concatenate them.
async function resolveHlsSubs(masterUrl) {
  let text;
  try {
    text = await (await fetch(masterUrl, { credentials: "include" })).text();
  } catch {
    return { ok: false, message: "Couldn't read the stream's subtitle list." };
  }
  const tracks = [];
  const re = /#EXT-X-MEDIA:([^\n]*TYPE=SUBTITLES[^\n]*)/gi;
  let m, i = 0;
  while ((m = re.exec(text))) {
    const uri = /URI="([^"]+)"/.exec(m[1]);
    if (!uri) continue;
    const name = /NAME="([^"]+)"/.exec(m[1]);
    const lang = /LANGUAGE="([^"]+)"/.exec(m[1]);
    try {
      tracks.push({
        id: "hls-sub-" + i++,
        url: new URL(uri[1], masterUrl).href,
        label: (name && name[1]) || (lang && lang[1]) || "Subtitles " + i,
        lang: (lang && lang[1]) || "",
        kind: "",
        hls: true,
      });
    } catch {}
  }
  if (!tracks.length) return { ok: false, message: "No subtitle tracks found in this stream." };
  return { ok: true, tracks };
}

async function fetchHlsVtt(playlistUrl) {
  const pl = await (await fetch(playlistUrl, { credentials: "include" })).text();
  if (!/#EXT/i.test(pl) && /-->/.test(pl)) return pl; // the URI was the .vtt itself
  const segs = pl
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((u) => {
      try {
        return new URL(u, playlistUrl).href;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!segs.length) return /-->/.test(pl) ? pl : "";
  const parts = [];
  for (const s of segs) {
    try {
      parts.push(await (await fetch(s, { credentials: "include" })).text());
    } catch {}
  }
  return parts.join("\n\n");
}

async function listSubtitles(req) {
  if (req.source === "youtube") {
    let vid = req.videoId;
    if (!vid && req.tabId != null) {
      const info = ytTabs.get(req.tabId);
      vid = info && info.videoId;
    }
    return resolveYouTubeSubs(vid);
  }
  if (req.source === "hls") return resolveHlsSubs(req.url);
  if (req.source === "url") {
    return { ok: true, tracks: [{ id: "u0", url: req.url, label: shortName(req.url), lang: "", kind: "" }] };
  }
  return { ok: false, message: "No subtitle source." };
}

// Ask the YouTube content script to fetch a caption track from the page context
// (the SW fetch gets an empty body). Resolves to the caption text, or null.
function fetchSubsViaPage(tabId, info) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "yt-fetch-subs", ...info }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok || !res.text) return resolve(null);
        resolve({ text: res.text, fmt: res.fmt || "" });
      });
    } catch {
      resolve(null);
    }
  });
}

// Map a captured timedtext fmt to a parser hint.
function fmtToHint(fmt) {
  if (fmt === "json3") return "json3";
  if (fmt === "vtt") return "vtt";
  return "xml"; // srv1/srv2/srv3/ttml all parse via parseTimedXml
}

async function getSubtitle(req) {
  await initReady; // settings (subfolder / askLocation) must be loaded first
  const track = req.track || {};
  try {
    let text, fromHint;
    if (track.hls) {
      text = await fetchHlsVtt(track.url);
      fromHint = "vtt";
    } else if (track.youtube) {
      fromHint = "vtt";
      // YouTube returns an EMPTY body when timedtext is fetched from the SW — it's
      // gated to the player's own page context. So ask the YouTube tab to fetch it
      // for us (same origin/session as the player → real cues). Fall back to the
      // SW fetch if the tab isn't available or the page comes up empty too.
      let page = null;
      if (req.tabId != null) {
        page = await fetchSubsViaPage(req.tabId, {
          lang: track.lang,
          kind: track.kind,
          tlang: req.tlang,
          url: track.url,
        });
      }
      if (page && page.text && page.text.trim()) {
        text = page.text;
        fromHint = fmtToHint(page.fmt);
      } else {
        let url = track.url + (track.url.includes("?") ? "&" : "?") + "fmt=vtt";
        if (req.tlang) url += "&tlang=" + encodeURIComponent(req.tlang);
        text = await (await fetch(url, { credentials: "include" })).text();
      }
    } else {
      fromHint = subExt(track.url);
      text = await (await fetch(track.url, { credentials: "include" })).text();
    }
    if (!text || !text.trim()) {
      return {
        ok: false,
        message:
          "The subtitle came back empty. Keep the YouTube tab open and signed in, make sure the video actually has captions, then try again.",
      };
    }
    const conv = convertSubs(text, fromHint, req.format || "srt");
    if (!conv) return { ok: false, message: "Couldn't parse those subtitles." };
    const base = cleanTitle(req.title || "subtitles") || "subtitles";
    const tag = req.tlang ? "." + req.tlang : track.lang ? "." + track.lang : "";
    const name = `${base}${tag}.${conv.ext}`;
    const saved = await saveTextFile(name, conv.mime, conv.data);
    if (saved.error) return { ok: false, message: saved.error };
    pushDownload({
      id: "sub-" + Date.now(),
      name,
      type: "subtitle",
      status: "completed",
      progress: 100,
      dlId: saved.dlId,
      size: conv.data.length,
    });
    return { ok: true, name };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

// --- thumbnail / poster grab -----------------------------------------------
// Save a still image for a video: the page's poster/og:image, or — for YouTube —
// the highest-res thumbnail the video has (maxres, falling back to hq).

async function youtubeThumb(id) {
  const maxres = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  try {
    const r = await fetch(maxres, { method: "HEAD" });
    if (r.ok) return maxres;
  } catch {}
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

async function grabThumbnail({ url, youtubeId, title }) {
  await initReady; // settings (subfolder / askLocation) must be loaded first
  let imgUrl = url;
  if (youtubeId) imgUrl = await youtubeThumb(youtubeId);
  if (!imgUrl) return { ok: false, message: "No thumbnail available for this video." };
  let ext = "jpg";
  const m = /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.exec(imgUrl);
  if (m) ext = m[1].toLowerCase().replace("jpeg", "jpg");
  const base = cleanTitle(title || "thumbnail") || "thumbnail";
  const name = `${base}.${ext}`;
  return new Promise((resolve) => {
    chrome.downloads.download({ url: imgUrl, filename: withFolder(name), saveAs: !!settings.askLocation }, (dlId) => {
      if (chrome.runtime.lastError || dlId == null) {
        resolve({ ok: false, message: chrome.runtime.lastError ? chrome.runtime.lastError.message : "Download failed." });
        return;
      }
      pushDownload({ id: "img-" + Date.now(), name, type: "image", status: "completed", progress: 100, dlId });
      resolve({ ok: true, name });
    });
  });
}

// --- "first successful save" milestone (drives the popup's one-time review card)
let sawSave = false;
function markSaved() {
  if (sawSave) return;
  sawSave = true;
  chrome.storage.local.set({ vc_hasSaved: true });
}

function fmtSize(bytes) {
  if (!bytes) return null;
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function cleanTitle(title) {
  // Trim common site suffixes like " - YouTube", " | Vimeo", " - Watch Online Free".
  // The Watch/Stream branch requires a marketing keyword after it so legitimate
  // title text ("Cool Video - Watch Until The End") isn't eaten.
  return title
    .replace(
      /\s*[-|–—]\s*(YouTube|Vimeo|Dailymotion|(?:Watch|Stream)(?:ing)?\b[^-|–—]*\b(?:online|free|now|full|movies?|tv|series|episodes?|hd|on\s+\S+)\b[^-|–—]*)$/i,
      ""
    )
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .slice(0, 90);
}

function modeName(entry) {
  const base = suggestFilename(entry).replace(/\.[^.]+$/, "");
  switch (entry.mode) {
    case "audio":
      return base + ".mp3";
    case "gif":
      return base + ".gif";
    case "clip":
      return base + "_clip.mp4";
    default:
      return suggestFilename(entry);
  }
}

function suggestFilename(entry) {
  const extFor = (t) => (t === "hls" ? ".ts" : t === "dash" ? ".mpd" : ".mp4");
  if (entry.title && entry.title.trim()) {
    const base = cleanTitle(entry.title) || "video";
    return base + extFor(entry.type);
  }
  let name = shortName(entry.url);
  if (!/\.[a-z0-9]{2,4}$/i.test(name)) name += extFor(entry.type);
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

function addMedia(tabId, partial) {
  if (tabId == null || tabId < 0) return;
  // Skip data: and blob: URLs. A blob: URL (what MediaSource players expose as a
  // <video>.currentSrc) belongs to the PAGE's context — the extension can't fetch
  // it, so offering it as a download just fails later with a NotReadableError
  // ("the requested file could not be read…"). The real downloadable source for
  // those sites is the HLS/DASH manifest the network sniffer catches instead.
  if (!partial.url || partial.url.startsWith("data:") || partial.url.startsWith("blob:")) return;
  // Individual stream segments (.ts/.m4s/range chunks) are parts of a stream
  // that's already represented by its .m3u8 — don't list them as downloads.
  if (isSegment(partial.url)) return;
  // Instagram/Facebook deliver video as DASH/range fetches off their CDNs — those
  // pieces don't play standalone (video-only, partial). We resolve IG posts via
  // the API instead (resolveInstagram → a full progressive MP4 with audio), so
  // suppress the noisy CDN media here.
  if (partial.source === "network") {
    try {
      const host = new URL(partial.url).hostname;
      if (/(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(host)) return;
      // Reddit: its HLS/CMAF variants fail to remux and show as 3 duplicate
      // entries. The content script surfaces the ready-made progressive MP4
      // (with the real title) instead, so suppress the raw v.redd.it noise.
      if (/(^|\.)v\.redd\.it$/i.test(host)) return;
    } catch {}
  }

  let list = mediaByTab.get(tabId);
  if (!list) {
    list = [];
    mediaByTab.set(tabId, list);
  }
  if (list.some((m) => m.url === partial.url)) return;

  const entry = {
    id: `${tabId}-${Date.now()}-${list.length}`,
    tabId,
    type: classify(partial.url, partial.contentType),
    source: partial.source || "network",
    size: partial.size || null,
    title: partial.title || null,
    ...partial,
  };

  // Collapse a master playlist and its quality variants (same folder) into one
  // entry, preferring the master so the merge auto-picks the best quality.
  if (entry.type === "hls") {
    const gk = groupKey(entry.url);
    const sibling = list.find((m) => m.type === "hls" && groupKey(m.url) === gk);
    if (sibling) {
      if (masterScore(entry.url) > masterScore(sibling.url)) {
        sibling.url = entry.url; // promote to the more master-like playlist
      }
      return; // already represented — don't add a duplicate row
    }
  }
  // Collapse repeated DASH manifest requests (same folder) into one entry.
  if (entry.type === "dash") {
    const gk = groupKey(entry.url);
    if (list.some((m) => m.type === "dash" && groupKey(m.url) === gk)) return;
  }

  // Hard cap so a stream that slips a novel segment pattern past isSegment() can
  // never flood the list/badge. Streams are represented by their manifest anyway.
  if (list.length >= 40) return;

  list.push(entry);
  updateBadge(tabId, list.length);

  // X / Twitter: name each stream after its own tweet (via the shared media id),
  // so a feed of videos doesn't show "(2) Home / X" on every row.
  if (!entry.title) {
    const xt = xTitleFor(tabId, entry.url);
    if (xt) entry.title = xt;
  }

  // Use the page title as a friendly default filename for network-detected media.
  // Record it as _pageTitle so a later, more specific X title can replace it.
  if (!entry.title) {
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.title) {
        entry.title = tab.title;
        entry._pageTitle = tab.title;
      }
    });
  }

  maybeQueuePrompt(tabId, entry);
}

// --- one-prompt-per-tab debounce -------------------------------------------
// Streaming sites fire dozens of media requests for a single video (HLS/DASH
// segments, range requests). We collect for a moment, then prompt ONCE per tab
// for the best candidate (largest / a whole file rather than a segment).

// A "segment" is one piece of a stream (HLS/DASH), not a whole video — we must
// NOT list these or the popup/badge floods with hundreds of entries (e.g. a DASH
// lecture fires a numbered .mp4/.m4s per few seconds). Detect the common segment
// naming so they're filtered out; only the manifest (.m3u8/.mpd) or a real whole
// file gets listed.
function isSegment(url) {
  if (/[?&](range|bytestart|byteend)=/i.test(url)) return true;
  let file;
  try {
    file = new URL(url).pathname.split("/").pop() || "";
  } catch {
    file = url.split(/[?#]/)[0].split("/").pop() || "";
  }
  if (/\.(ts|m4s|cmfv|cmfa|cmft|dash)(\?|#|$)/i.test(file)) return true;
  // init segments: init.mp4, init-stream0.m4s, video_init.mp4 …
  if (/(^|[-_])init([-_.]|$)/i.test(file)) return true;
  // numbered segments: seg-12.mp4, segment_3.m4s, chunk-stream0-00001.mp4, frag5.mp4
  if (/(seg|segment|chunk|frag(ment)?|media|part)[-_]?\d+/i.test(file)) return true;
  // bare numbered media files: 0001.mp4, 12.m4s, 00012.cmfv (DASH/HLS packagers)
  if (/(^|[-_/])\d{1,7}\.(mp4|m4v|m4s|webm|cmfv|cmfa)(\?|#|$)/i.test(file)) return true;
  return false;
}

// Same origin + same folder = playlists belonging to one video.
function groupKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/[^/]*$/, "");
  } catch {
    return url;
  }
}

// Higher = more likely a master playlist (the one we want to keep).
function masterScore(url) {
  const f = url.toLowerCase();
  let s = 0;
  if (/master|main|manifest|playlist/.test(f)) s += 10;
  if (/\d{3,4}p|\d{3,4}x\d{3,4}|v\d+-a\d+|audio|chunklist|seg/.test(f)) s -= 5;
  return s;
}

function score(e) {
  let s = 0;
  if (e.type === "video") s += 1000; // progressive file beats a stream manifest
  if (isSegment(e.url)) s -= 5000;   // segments are parts, not the whole video
  if (e.size) s += Math.min(e.size / 1e6, 2000); // bigger = more likely the real one
  return s;
}

function maybeQueuePrompt(tabId, entry) {
  if (!settings.autoPrompt) return;
  if (entry.source === "youtube" || entry.source === "reddit") return; // surfaced in the popup; don't auto-prompt
  if (entry.url.startsWith("blob:")) return; // not downloadable
  if (tabPrompted.has(tabId)) return;        // already prompted for this tab

  let pending = tabPending.get(tabId);
  if (!pending) {
    pending = { best: entry, timer: null };
    tabPending.set(tabId, pending);
  } else if (score(entry) > score(pending.best)) {
    pending.best = entry;
  }
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    tabPending.delete(tabId);
    tabPrompted.add(tabId);
    promptDownload(pending.best);
  }, 1200);
}

// --- the "do you want to download?" prompt ---------------------------------

function promptDownload(entry) {
  const bits = [
    entry.type === "hls" ? "HLS stream" : entry.type === "dash" ? "DASH stream" : "video",
  ];
  const sz = fmtSize(entry.size);
  if (sz) bits.push(sz);
  chrome.notifications.create(
    {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Video detected — download it?",
      message: `${shortName(entry.url)}\n${bits.join(" · ")}`,
      contextMessage: sz ? `Size: ${sz}` : "Size unknown",
      buttons: [{ title: "Download" }, { title: "Ignore" }],
      priority: 2,
      requireInteraction: false,
    },
    (id) => {
      if (id) notifMap.set(id, entry);
    }
  );
}

chrome.notifications.onButtonClicked.addListener((id, btnIdx) => {
  const entry = notifMap.get(id);
  if (entry && btnIdx === 0) doDownload(entry);
  chrome.notifications.clear(id);
  notifMap.delete(id);
});

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  notifMap.delete(id);
});

// A notification that times out / is dismissed never fires the click handlers —
// without this, its notifMap entry leaks for the life of the worker.
chrome.notifications.onClosed.addListener((id) => {
  notifMap.delete(id);
});

// --- downloading -----------------------------------------------------------

const hlsJobs = new Map(); // id -> entry (in-flight stream merges)

// Best downloadable media on a tab — used by the in-video overlay button.
function pickBest(tabId) {
  const list = mediaByTab.get(tabId) || [];
  const usable = list.filter((m) => !m.url.startsWith("blob:"));
  if (!usable.length) return null;
  const hls = usable.find((m) => m.type === "hls");
  if (hls) return hls;
  const vids = usable.filter((m) => m.type === "video").sort((a, b) => (b.size || 0) - (a.size || 0));
  return vids[0] || usable[0];
}

// The v.redd.it media id from a video/packaged URL (audio lives under the same id).
function redditIdFromUrl(url) {
  const m = /(?:packaged-media|v)\.redd\.it\/([A-Za-z0-9]+)/i.exec(url || "");
  return m ? m[1] : null;
}

// --- X / Twitter naming + per-video catch ----------------------------------
// X streams are HLS from video.twimg.com; each carries a numeric media id that
// also appears in the tweet video's poster. The content script reports id→title
// so we can name each stream after its own tweet (instead of "Home / X"), and
// the Catch button sends a hovered video's id so we download exactly that one.
const xTitles = new Map(); // tabId -> Map(mediaId -> title)

function xMediaId(url) {
  const m = /(?:amplify_video|ext_tw_video|tweet_video)(?:_thumb)?\/(\d+)/i.exec(url || "");
  return m ? m[1] : null;
}

function noteXTitle(tabId, mediaId, title) {
  if (tabId == null || tabId < 0 || !mediaId || !title) return;
  let m = xTitles.get(tabId);
  if (!m) {
    m = new Map();
    xTitles.set(tabId, m);
  }
  m.set(mediaId, title);
  // Backfill any already-detected stream on this tab that shares the id but got
  // stuck with the generic page title.
  const list = mediaByTab.get(tabId);
  if (list) {
    for (const e of list) {
      if (xMediaId(e.url) === mediaId && (!e.title || / \/ X$| \/ Twitter$/i.test(e.title) || e.title === e._pageTitle)) {
        e.title = title;
      }
    }
  }
}

function xTitleFor(tabId, url) {
  const id = xMediaId(url);
  if (!id) return null;
  const m = xTitles.get(tabId);
  return (m && m.get(id)) || null;
}

function doDownload(entry) {
  // Don't start with default settings if storage hasn't loaded yet (SW-wake race)
  // — requeue this call for the moment init finishes.
  if (!initFinished) {
    initReady.then(() => doDownload(entry));
    return;
  }
  // Reddit: the packaged/CMAF video is silent — resolve the matching CMAF video +
  // audio from the media id and mux them. Route ALL reddit URLs here (incl. the
  // HLS master .m3u8, whose CMAF remux was failing → silent files); redditTracks
  // pulls proper single-file tracks from the id regardless of the entry URL.
  const rid = entry.redditId || redditIdFromUrl(entry.url);
  if (rid && (entry.source === "reddit" || /(?:packaged-media|v)\.redd\.it/i.test(entry.url))) {
    mergeReddit({ ...entry, redditId: rid });
    return;
  }
  if (entry.type === "hls") {
    mergeHls(entry);
    return;
  }
  if (entry.type === "dash") {
    mergeDash(entry);
    return;
  }
  const mode = entry.mode || "video";
  const httpUrl = !entry.url.startsWith("blob:") && /^https?:/i.test(entry.url);

  // Plain direct video + "Ask where to save" → hand it straight to the browser
  // so the Save-As dialog appears at the START of the download (and there's
  // exactly one prompt). The accelerator can only prompt at the end, because it
  // assembles the file in memory first.
  if (mode === "video" && httpUrl && settings.askLocation) {
    normalDownload(entry);
    return;
  }

  // Otherwise use the parallel-range accelerator (faster, live progress).
  // Audio/clip/gif modes need ffmpeg, so always route them through offscreen.
  if (httpUrl) {
    if (mode !== "video" || !entry.size || entry.size <= ACCEL_MAX_BYTES) {
      accelerateFile(entry);
      return;
    }
  }
  normalDownload(entry);
}

function normalDownload(entry, filename) {
  const name = filename || suggestFilename(entry);
  pushDownload({
    id: entry.id,
    name,
    type: entry.type || "video",
    status: "downloading",
    progress: null, // browser-managed, no live %
    phase: null,
    kind: "browser",
    req: entry,
  });
  chrome.downloads.download(
    { url: entry.url, filename: withFolder(name), saveAs: !!settings.askLocation },
    (dlId) => {
      if (chrome.runtime.lastError || dlId == null) {
        patchDownload(entry.id, {
          status: "failed",
          error: chrome.runtime.lastError ? chrome.runtime.lastError.message : "failed",
        });
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Could not download directly",
          message: chrome.runtime.lastError ? chrome.runtime.lastError.message : "Download failed",
        });
        return;
      }
      // The user may have hit Cancel before this callback fired (the dlId didn't
      // exist yet). If so, cancel the browser download now.
      const rec = downloads.find((d) => d.id === entry.id);
      if (rec && (rec.status === "canceled" || rec.status === "failed")) {
        try {
          chrome.downloads.cancel(dlId);
        } catch {}
        return;
      }
      patchDownload(entry.id, { dlId });
      const onChanged = (delta) => {
        if (delta.id !== dlId || !delta.state) return;
        if (delta.state.current === "complete") {
          chrome.downloads.onChanged.removeListener(onChanged);
          patchDownload(entry.id, { status: "completed", progress: 100, dlId });
        } else if (delta.state.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(onChanged);
          patchDownload(entry.id, { status: "failed", error: "interrupted" });
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    }
  );
}

async function accelerateFile(entry) {
  await ensureOffscreen();
  hlsJobs.set(entry.id, entry);
  pushDownload({
    id: entry.id,
    name: modeName(entry),
    type: "video",
    status: "downloading",
    progress: 0,
    phase: "fetching",
    kind: "blob",
    req: entry,
  });
  chrome.notifications.create(`start-${entry.id}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Downloading (accelerated)…",
    message: cleanTitle(entry.title || shortName(entry.url)),
  });
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "file-download",
    id: entry.id,
    url: entry.url,
    filename: suggestFilename(entry),
    size: entry.size,
    maxBytes: ACCEL_MAX_BYTES,
    concurrency: concurrency(),
    mode: entry.mode || "video",
    start: entry.start || 0,
    end: entry.end || 0,
  });
}

// --- HLS merge via offscreen document --------------------------------------

let offscreenCreating = null;

async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
  } catch {}
  try {
    if (!offscreenCreating) {
      offscreenCreating = chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Fetch and merge HLS video segments into one downloadable file.",
      });
    }
    await offscreenCreating;
  } catch (e) {
    if (!/single offscreen/i.test(String(e.message))) throw e;
  } finally {
    offscreenCreating = null;
  }
}

async function mergeHls(entry) {
  await ensureOffscreen();
  hlsJobs.set(entry.id, entry);
  pushDownload({
    id: entry.id,
    name: modeName(entry),
    type: "hls",
    status: "downloading",
    progress: 0,
    phase: "fetching",
    kind: "blob",
    req: entry,
  });
  chrome.notifications.create(`start-${entry.id}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Downloading stream…",
    message: `${cleanTitle(entry.title || shortName(entry.url))} — fetching segments`,
  });
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "hls-download",
    id: entry.id,
    url: entry.mergeUrl || entry.url, // a specific quality variant, if chosen
    masterUrl: entry.url, // the (collapsed) master, for audio-track resolution
    filename: suggestFilename(entry),
    concurrency: concurrency(),
    convert: settings.convertMp4 !== false,
    mode: entry.mode || "video",
    start: entry.start || 0,
    end: entry.end || 0,
  });
}

async function mergeDash(entry) {
  await ensureOffscreen();
  hlsJobs.set(entry.id, entry);
  pushDownload({
    id: entry.id,
    name: modeName(entry),
    type: "dash",
    status: "downloading",
    progress: 0,
    phase: "fetching",
    kind: "blob",
    req: entry,
  });
  chrome.notifications.create(`start-${entry.id}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Downloading stream…",
    message: `${cleanTitle(entry.title || shortName(entry.url))} — fetching DASH segments`,
  });
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "dash-download",
    id: entry.id,
    url: entry.mergeUrl || entry.url,
    filename: suggestFilename(entry),
    concurrency: concurrency(),
    convert: settings.convertMp4 !== false,
    mode: entry.mode || "video",
    start: entry.start || 0,
    end: entry.end || 0,
  });
}

// Resolve a Reddit video's downloadable VIDEO + AUDIO tracks from its media id.
// Reddit's DASH uses single-file CMAF (SegmentBase), so each Representation's
// <BaseURL> (e.g. CMAF_360.mp4, CMAF_AUDIO_128.mp4) is a complete MP4 we can grab
// directly and mux — no HLS/CMAF-segment remux (which was failing → silent files).
// preferVideo: use the caller's packaged MP4 if it's a real file (higher quality),
// otherwise fall back to the manifest's best CMAF video.
async function redditTracks(id, preferVideo) {
  const abs = (f) => `https://v.redd.it/${id}/${f}`;
  const bitrate = (s) => parseInt((String(s).match(/_(\d+)\.mp4/) || String(s).match(/(\d+)/) || [])[1] || 0, 10);
  // Only use the caller's URL as the video if it's a real MP4 file — NOT a manifest
  // (.mpd/.m3u8). Paste-link entries carry the DASH manifest URL as a placeholder;
  // muxing that as "video" produced the FS error. Manifests fall through to the
  // CMAF BaseURL resolved from the mpd below.
  const usableVideo =
    preferVideo &&
    /^https?:/i.test(preferVideo) &&
    (/\.mp4(\?|#|$)/i.test(preferVideo) || /(^|\.)packaged-media\.redd\.it/i.test(preferVideo)) &&
    !/\.(m3u8|mpd)(\?|#|$)/i.test(preferVideo);
  let video = usableVideo ? preferVideo : null;
  let audio = null;
  try {
    const mpd = await (await fetch(abs("DASHPlaylist.mpd"), { credentials: "omit" })).text();
    const bases = [...new Set((mpd.match(/<BaseURL>([^<]+)<\/BaseURL>/g) || []).map((s) => s.replace(/<\/?BaseURL>/g, "")))];
    const audios = bases.filter((b) => /AUDIO/i.test(b)).sort((a, b) => bitrate(b) - bitrate(a));
    const videos = bases.filter((b) => !/AUDIO/i.test(b)).sort((a, b) => bitrate(b) - bitrate(a));
    if (audios[0]) audio = abs(audios[0]);
    if (!video && videos[0]) video = abs(videos[0]);
    // A manifest with video BaseURLs but no AUDIO = a genuinely silent video.
    if (!audio && videos.length) audio = null;
  } catch {}
  // Fallbacks if the manifest was unavailable.
  if (!audio) {
    for (const f of ["CMAF_AUDIO_128.mp4", "CMAF_AUDIO_64.mp4", "DASH_AUDIO_128.mp4"]) {
      try {
        const r = await fetch(abs(f), { method: "GET", headers: { Range: "bytes=0-1" } });
        if (r.status === 206 || r.ok) {
          audio = abs(f);
          break;
        }
      } catch {}
    }
  }
  if (!video) video = preferVideo || abs("CMAF_360.mp4");
  return { video, audio };
}

async function mergeReddit(entry) {
  await ensureOffscreen();
  hlsJobs.set(entry.id, entry);
  pushDownload({
    id: entry.id,
    name: modeName(entry),
    type: "reddit",
    status: "downloading",
    progress: 0,
    phase: "fetching",
    kind: "blob",
    req: entry,
  });
  chrome.notifications.create(`start-${entry.id}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Downloading video…",
    message: `${cleanTitle(entry.title || shortName(entry.url))} — fetching video + audio`,
  });
  const { video, audio } = await redditTracks(entry.redditId, entry.url);
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "reddit-av",
    id: entry.id,
    videoUrl: video,
    audioUrl: audio, // null → save the video track as-is (silent source)
    // Base name — emitWithMode appends the _clip/.mp3/.gif suffix for the tools.
    filename: suggestFilename(entry),
    mode: entry.mode || "video",
    start: entry.start || 0,
    end: entry.end || 0,
  });
}

function relayToPopup(message) {
  // Popup may be closed — swallow the "no receiver" error.
  chrome.runtime.sendMessage(message).catch(() => {});
}

function handleHlsProgress({ id, done, total }) {
  const pct = Math.round((done / total) * 100);
  const entry = hlsJobs.get(id);
  if (entry && entry.tabId != null) {
    chrome.action.setBadgeText({ tabId: entry.tabId, text: `${pct}%` }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId: entry.tabId, color: "#16a34a" }).catch(() => {});
  }
  patchDownload(id, { progress: pct });
  relayToPopup({ type: "hls-progress-ui", id, done, total });
}

// Fallback save via an anchor click in the offscreen doc — but VERIFIED: the
// anchor download still goes through the browser's download system, so we watch
// chrome.downloads.onCreated for our (unique) blob URL. Only then is the record
// marked completed; if nothing starts within 8s we report a real failure instead
// of a phantom "Saved ✓".
function anchorSaveVerified(id, objUrl, filename, bytes) {
  let settled = false;
  const onCreated = (item) => {
    if (!item || item.url !== objUrl || settled) return;
    settled = true;
    chrome.downloads.onCreated.removeListener(onCreated);
    patchDownload(id, { status: "completed", progress: 100, phase: null, name: filename, size: bytes, dlId: item.id });
    relayToPopup({ type: "hls-done-ui", id });
    finishJob(id);
  };
  chrome.downloads.onCreated.addListener(onCreated);
  chrome.runtime.sendMessage({ target: "offscreen", type: "save-anchor", objUrl, filename: withFolder(filename) });
  setTimeout(() => {
    if (settled) return;
    settled = true;
    chrome.downloads.onCreated.removeListener(onCreated);
    patchDownload(id, { status: "failed", error: "save failed (fallback save did not start)", phase: null });
    relayToPopup({ type: "hls-error-ui", id, error: "save failed" });
    finishJob(id);
  }, 8000);
}

// The offscreen doc produces a Blob URL and hands it to us; WE save it via the
// downloads API. This gives a real "Save as…" dialog (when askLocation is on),
// a real download id (so completion is reliable and pause/resume work), instead
// of an anchor click that can never prompt and breaks if the worker sleeps.
function handleHlsReady({ id, objUrl, filename, bytes }) {
  const rec = downloads.find((d) => d.id === id);
  // The user canceled while we were fetching/converting → the record is gone. Drop
  // the finished blob (revoke it) and save NOTHING — a cancel must leave no file.
  if (!rec || canceledIds.has(id)) {
    chrome.runtime.sendMessage({ target: "offscreen", type: "hls-revoke", objUrl });
    finishJob(id);
    return;
  }
  // Don't save if the job is already canceled/failed/finished, and never kick off
  // a second save for a job that's already saving (guards double-prompt).
  if (rec.status === "canceled" || rec.status === "failed" || rec.status === "completed") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "hls-revoke", objUrl });
    finishJob(id);
    return;
  }
  if (rec && rec.phase === "saving") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "hls-revoke", objUrl });
    return;
  }

  patchDownload(id, { phase: "saving" });

  chrome.downloads.download({ url: objUrl, filename: withFolder(filename), saveAs: !!settings.askLocation }, (dlId) => {
    if (chrome.runtime.lastError || dlId == null) {
      // Couldn't save the blob through the downloads API — fall back to an
      // anchor click in the offscreen doc, VERIFIED via downloads.onCreated so a
      // silent anchor failure is reported instead of a phantom success.
      anchorSaveVerified(id, objUrl, filename, bytes);
      return;
    }
    patchDownload(id, { dlId, kind: "browser-save" });
    const onChanged = (delta) => {
      if (delta.id !== dlId || !delta.state) return;
      if (delta.state.current !== "complete" && delta.state.current !== "interrupted") return;
      chrome.downloads.onChanged.removeListener(onChanged);

      if (delta.state.current === "complete") {
        chrome.runtime.sendMessage({ target: "offscreen", type: "hls-revoke", objUrl });
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Saved ✓",
          message: `${filename} downloaded.`,
        });
        patchDownload(id, { status: "completed", progress: 100, phase: null, name: filename, size: bytes, dlId });
        relayToPopup({ type: "hls-done-ui", id });
        finishJob(id);
        return;
      }

      // Interrupted.
      const err = (delta.error && delta.error.current) || "";
      if (/USER_CANCELED/i.test(err)) {
        chrome.runtime.sendMessage({ target: "offscreen", type: "hls-revoke", objUrl });
        patchDownload(id, { status: "canceled", phase: null });
        finishJob(id);
        return;
      }

      // The browser couldn't read the cross-context blob to finish the save — this
      // is the "the requested file could not be read…" failure that hits larger
      // files (the blob lives in the offscreen doc; the SW-initiated download can
      // fail to read it mid-save). Retry the save from INSIDE the offscreen doc,
      // where the blob is local. Do NOT revoke first — anchorSave needs the blob;
      // the 15-min safety timer in saveBlob() cleans it up.
      console.warn("[VideoCatch] blob save interrupted, retrying via offscreen anchor:", err);
      anchorSaveVerified(id, objUrl, filename, bytes);
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

// Drop a job from in-flight tracking and refresh the tab badge.
function finishJob(id) {
  const entry = hlsJobs.get(id);
  if (entry && entry.tabId != null) {
    const list = mediaByTab.get(entry.tabId);
    updateBadge(entry.tabId, list ? list.length : 0);
  }
  hlsJobs.delete(id);
  // A finished download can't stay "priority" — clear it so the flag/offscreen bias
  // don't linger (and the popup badge disappears).
  if (priorityDownloadId === id) setDownloadPriority(null);
}

// --- soft download priority (first dibs on fetch slots + convert queue) ------
let priorityDownloadId = null;
function setDownloadPriority(id) {
  // Toggle: clicking ⚡ on the already-prioritized row clears it.
  const next = id != null && priorityDownloadId === id ? null : id;
  priorityDownloadId = next;
  // Mirror onto the records so the popup can badge the chosen row.
  let changed = false;
  for (const d of downloads) {
    const want = d.id === next;
    if (!!d.priority !== want) {
      d.priority = want;
      changed = true;
    }
  }
  chrome.runtime.sendMessage({ target: "offscreen", type: "set-priority", id: next });
  if (changed) {
    persistDownloads();
    broadcastDownloads();
  }
}

function notifyHlsError(id, error) {
  finishJob(id);
  patchDownload(id, { status: "failed", error: error || "failed", phase: null });
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Stream download failed",
    message: error || "Could not merge this stream.",
  });
  relayToPopup({ type: "hls-error-ui", id, error });
}

// --- pause / resume / cancel / retry ---------------------------------------

// Find the running YouTube capture for a download record (its buffering happens in
// the PAGE hook, not the offscreen doc, so pause/resume must go to the tab).
function ytCaptureFor(id) {
  for (const [captureId, cap] of ytCaptures) {
    if (cap.recordId === id) return { captureId, cap };
  }
  return null;
}

function pauseDownload(id) {
  const r = downloads.find((d) => d.id === id);
  if (!r || r.status !== "downloading") return;
  if (r.type === "youtube") {
    const yc = ytCaptureFor(id);
    if (yc) chrome.tabs.sendMessage(yc.cap.tabId, { type: "yt-do-pause", captureId: yc.captureId }, () => void chrome.runtime.lastError);
    patchDownload(id, { status: "paused" });
    return;
  }
  if (r.kind === "blob" && r.phase === "fetching") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "job-pause", id });
    patchDownload(id, { status: "paused" });
  } else if (r.dlId != null) {
    chrome.downloads.pause(r.dlId, () => {
      if (!chrome.runtime.lastError) patchDownload(id, { status: "paused" });
    });
  }
}

function resumeDownload(id) {
  const r = downloads.find((d) => d.id === id);
  if (!r || r.status !== "paused") return;
  if (r.type === "youtube") {
    const yc = ytCaptureFor(id);
    if (yc) chrome.tabs.sendMessage(yc.cap.tabId, { type: "yt-do-resume", captureId: yc.captureId }, () => void chrome.runtime.lastError);
    patchDownload(id, { status: "downloading" });
    return;
  }
  if (r.kind === "blob" && r.phase === "fetching") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "job-resume", id });
    patchDownload(id, { status: "downloading" });
  } else if (r.dlId != null) {
    chrome.downloads.resume(r.dlId, () => {
      if (!chrome.runtime.lastError) patchDownload(id, { status: "downloading" });
    });
  }
}

function cancelDownload(id) {
  const r = downloads.find((d) => d.id === id);
  if (!r) return;
  if (r.type === "youtube") setCaptureAdBlock(null, false); // capture canceled
  // If this is a YouTube capture, tell the PAGE to stop auto-buffering — otherwise
  // the video keeps fast-forwarding at 16x after the user cancels — and drop the
  // captured bytes held in the offscreen doc.
  for (const [captureId, cap] of ytCaptures) {
    if (cap.recordId === id) {
      chrome.tabs.sendMessage(cap.tabId, { type: "yt-do-stop", captureId }, () => void chrome.runtime.lastError);
      forwardToOffscreen({ type: "yt-cap-cancel", captureId }); // ordered after in-flight fragments
      ytCaptures.delete(captureId);
      hlsJobs.delete(id);
      break;
    }
  }
  if (r.kind === "blob" || r.kind === "browser-save") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "job-cancel", id });
  }
  if (r.dlId != null) {
    try {
      chrome.downloads.cancel(r.dlId);
    } catch {}
    // A user cancel should leave NOTHING behind — delete the partial file from disk
    // and remove the browser's history entry (a failure keeps its data for Retry).
    try {
      chrome.downloads.removeFile(r.dlId, () => void chrome.runtime.lastError);
    } catch {}
    try {
      chrome.downloads.erase({ id: r.dlId }, () => void chrome.runtime.lastError);
    } catch {}
  }
  finishJob(id);
  canceledIds.add(id); // guard: ignore any in-flight blob that arrives after cancel
  // Keep the guard set bounded (oldest entries first — Set iterates insertion order).
  while (canceledIds.size > 300) canceledIds.delete(canceledIds.values().next().value);
  removeDownload(id); // wipe the row + all gathered data (cancel ≠ failure)
}

function retryDownload(id) {
  const r = downloads.find((d) => d.id === id);
  if (!r || !r.req) return;
  // Abort any lingering workers from the failed attempt BEFORE restarting — otherwise
  // they keep posting progress and fight the retry (the "two progress bars / % blinks
  // between 52% and 2%" bug). The offscreen `beginRun` gives the retry a fresh control.
  // While restarting, SWALLOW the old attempt's job-canceled/hls-error (our own
  // job-cancel triggers a "canceled" that would otherwise leave the row stuck showing
  // "cancelled" and block the restart) — cleared right before the new run starts.
  restartingIds.add(id);
  chrome.runtime.sendMessage({ target: "offscreen", type: "job-cancel", id });
  if (r.dlId != null) {
    try {
      chrome.downloads.cancel(r.dlId);
    } catch {}
  }
  patchDownload(id, { status: "downloading", progress: 0, error: null, phase: "fetching", dlId: null });
  // Small delay so the aborted workers actually stop before the new job starts.
  setTimeout(() => {
    restartingIds.delete(id);
    const cur = downloads.find((d) => d.id === id);
    // Restart unless the user removed/canceled the row (cancel wipes it) or it already
    // finished; don't require exactly "downloading" — a stray status flip shouldn't
    // silently swallow the retry.
    if (cur && cur.status !== "completed" && cur.status !== "canceled") doDownload(r.req);
  }, 500);
}

function removeDownload(id) {
  downloads = downloads.filter((d) => d.id !== id);
  persistDownloads();
  broadcastDownloads();
}

// --- YouTube capture (MediaSource tap — the only thing that works in 2026) --
// YouTube can't be grabbed by URL (SABR + signature cipher). The content-script
// hook (yt-hook.js) captures the fMP4 bytes the player buffers; we orchestrate
// start/save here and route the captured tracks to the offscreen muxer.

const ytTabs = new Map();      // tabId -> { videoId, title }
const ytCaptures = new Map();  // captureId -> { recordId, filename, tabId }
let ytCaptureSeq = 0;

// STRICT FIFO forwarding of capture-stream messages to the offscreen store.
// Each `ensureOffscreen().then(send)` is an independent async hop, so two
// messages could land out of order — catastrophic for a stream: a `wipe`
// (stream restart) landing after the fresh stream's `init` deletes the codec
// config, so every mux attempt fails and the capture degrades to the raw
// split save ("why am I getting two files"). One promise chain = one order.
let offscreenChain = Promise.resolve();
function forwardToOffscreen(msg) {
  offscreenChain = offscreenChain
    .then(() => ensureOffscreen())
    .then(() => chrome.runtime.sendMessage({ target: "offscreen", ...msg }))
    .catch(() => {});
}

// --- capture-scoped ad blocking --------------------------------------------
// Ads interrupt the player's buffering and can leave gaps in the captured video.
// While a YouTube capture is running we block ad DELIVERY + tracking endpoints,
// scoped to just that tab, then remove the rules the moment capture ends. This is
// OFF during normal browsing (so it never conflicts with ads we might show) and
// deliberately avoids blocking googlevideo content, so it won't break playback.
const AD_FILTERS = [
  "||googlesyndication.com^",
  "||googleadservices.com^",
  "||doubleclick.net^",
  "||youtube.com/pagead/",
  "||youtube.com/ptracking",
  "||youtube.com/api/stats/ads",
  "||youtube.com/get_midroll_info",
  "||youtube.com/get_ad_break",
  "||youtube.com/youtubei/v1/player/ad_break",
];
const AD_RULE_BASE = 22000;
const AD_RULE_IDS = AD_FILTERS.map((_, i) => AD_RULE_BASE + i);

function captureAdRules(tabId) {
  return AD_FILTERS.map((urlFilter, i) => ({
    id: AD_RULE_BASE + i,
    priority: 1,
    action: { type: "block" },
    condition: { urlFilter, tabIds: [tabId] },
  }));
}

async function setCaptureAdBlock(tabId, on) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
  try {
    if (on && tabId != null && tabId >= 0 && settings.skipAds !== false) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: AD_RULE_IDS,
        addRules: captureAdRules(tabId),
      });
    } else {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: AD_RULE_IDS });
    }
  } catch {
    /* declarativeNetRequest unavailable — capture still works, just without the block */
  }
}

// Clear any stale ad-block rules left over from a previous session.
setCaptureAdBlock(null, false);

function ytNote(tabId, videoId, title) {
  if (tabId == null) return;
  ytTabs.set(tabId, { videoId, title });
}

// One-click: create the download record, then tell the page hook to auto-buffer
// the whole video at 16x and finalize itself when done.
function ytCapture(tabId, auto = true, rangeStart = 0, rangeEnd = 0) {
  if (tabId == null) return;
  const info = ytTabs.get(tabId) || {};
  const captureId = `ytc-${Date.now()}-${ytCaptureSeq++}`;
  const recordId = `yt-${Date.now()}-${ytCaptureSeq}`;
  const filename = (cleanTitle(info.title || "youtube-video") || "youtube-video") + ".mp4";
  // Remember the requested window so yt-cap-done can hand it to the muxer, which
  // trims the captured stream to exactly [rangeStart, rangeEnd].
  ytCaptures.set(captureId, { recordId, filename, tabId, rangeStart, rangeEnd });
  pushDownload({
    id: recordId,
    name: filename,
    type: "youtube",
    status: "downloading",
    progress: 0,
    phase: "fetching",
    kind: "blob",
    // Enough to re-run this exact capture from the Downloads tab (Retry /
    // Re-capture) if it fails or the file comes out glitchy.
    ytReq: { tabId, rangeStart, rangeEnd },
  });
  hlsJobs.set(recordId, { id: recordId, tabId });
  // Block ad delivery in this tab for the duration of the capture (cleaner video).
  setCaptureAdBlock(tabId, true);
  // Safety: never leave the block on if the capture stalls without a done event.
  setTimeout(() => setCaptureAdBlock(null, false), 10 * 60 * 1000);
  chrome.tabs.sendMessage(
    tabId,
    { type: "yt-do-start", captureId, auto, skipAds: settings.skipAds !== false, rangeStart, rangeEnd },
    () => void chrome.runtime.lastError
  );
}

function ytFinalize(tabId) {
  // Manual finalize (non-auto): find this tab's active capture and ship it.
  for (const [captureId, cap] of ytCaptures) {
    if (cap.tabId === tabId) {
      chrome.tabs.sendMessage(tabId, { type: "yt-do-finalize", captureId }, () => void chrome.runtime.lastError);
      return;
    }
  }
}

function ytOnStatus(msg) {
  const cap = msg.captureId && ytCaptures.get(msg.captureId);
  if (msg.evt === "error") {
    if (cap) {
      patchDownload(cap.recordId, { status: "failed", error: msg.reason || "capture failed", phase: null });
      ytCaptures.delete(msg.captureId);
      finishJob(cap.recordId);
    }
    setCaptureAdBlock(null, false); // capture ended — lift the ad block
    relayToPopup({ type: "yt-cap-status-ui", evt: "error", reason: msg.reason, tabId: cap && cap.tabId });
    return;
  }
  // The hook reads the real title from the player API (reliable once playing) —
  // use it to name the file/record instead of the placeholder "youtube-video".
  if (cap && msg.title) {
    const better = (cleanTitle(msg.title) || "youtube-video") + ".mp4";
    if (better !== cap.filename) {
      cap.filename = better;
      patchDownload(cap.recordId, { name: better });
    }
  }
  if (cap && typeof msg.pct === "number") {
    patchDownload(cap.recordId, { progress: msg.pct, phase: "fetching" });
  }
  relayToPopup({ type: "yt-cap-status-ui", evt: msg.evt, video: msg.video, audio: msg.audio, pct: msg.pct, overflow: msg.overflow, ad: msg.ad, tabId: cap && cap.tabId });
}

// --- network sniffing ------------------------------------------------------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (VIDEO_EXT.test(details.url)) {
      addMedia(details.tabId, { url: details.url, source: "network" });
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const headers = details.responseHeaders || [];
    let contentType = "";
    let size = null;
    for (const h of headers) {
      const name = h.name.toLowerCase();
      if (name === "content-type") contentType = h.value || "";
      if (name === "content-length") size = parseInt(h.value, 10) || null;
    }
    const isVideo =
      /^video\//i.test(contentType) ||
      /mpegurl|dash\+xml/i.test(contentType) ||
      VIDEO_EXT.test(details.url);
    if (isVideo) {
      addMedia(details.tabId, { url: details.url, contentType, size, source: "network" });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// --- badge + cleanup -------------------------------------------------------

function updateBadge(tabId, count) {
  if (tabId == null || tabId < 0) return;
  const text = count > 0 ? String(count) : "";
  // These return promises in MV3 and reject if the tab has since closed.
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" }).catch(() => {});
}

function forgetTab(tabId) {
  mediaByTab.delete(tabId);
  tabPrompted.delete(tabId);
  xTitles.delete(tabId);
  const pending = tabPending.get(tabId);
  if (pending && pending.timer) clearTimeout(pending.timer);
  tabPending.delete(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Clear stale results when the tab navigates to a new page — or reloads the same
  // URL (a refresh fires "loading" but no changeInfo.url), so old detections (e.g.
  // a previous Reddit post's video) don't linger and get grabbed by mistake.
  if (changeInfo.url || changeInfo.status === "loading") {
    forgetTab(tabId);
    updateBadge(tabId, 0);
  }
});

// --- messaging (popup + content script) ------------------------------------

function parseMasterVariants(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const bw = /BANDWIDTH=(\d+)/.exec(lines[i]);
      const res = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
      const uri = lines[i + 1] && !lines[i + 1].startsWith("#") ? lines[i + 1].trim() : null;
      if (uri) {
        variants.push({
          bandwidth: bw ? +bw[1] : 0,
          height: res ? +res[2] : 0,
          url: new URL(uri, baseUrl).href,
        });
      }
    }
  }
  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  return variants;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "offscreen") return; // bound for the offscreen doc, not us

  if (msg.type === "overlay-download") {
    const tabId = sender.tab && sender.tab.id;
    const best = pickBest(tabId);
    if (best) doDownload(best);
    sendResponse({ ok: !!best });
    return; // synchronous
  }

  if (msg.type === "catch-reddit") {
    // The Catch button resolved the SPECIFIC hovered video — download exactly it.
    const tabId = sender.tab && sender.tab.id;
    if (msg.url) {
      doDownload({
        id: `reddit-${Date.now()}`,
        tabId: tabId == null ? -1 : tabId,
        type: /\.m3u8/i.test(msg.url) ? "hls" : "video",
        source: "reddit",
        url: msg.url,
        title: msg.title || null,
      });
    }
    sendResponse({ ok: !!msg.url });
    return; // synchronous
  }

  if (msg.type === "catch-instagram") {
    // The Catch button resolved which IG post is under the pointer — resolve it via
    // the media API (feed videos are only a blob otherwise) and download it.
    const tabId = sender.tab && sender.tab.id;
    resolveLink(msg.url, tabId)
      .then((res) => {
        if (res && res.ok && res.items && res.items.length) {
          doDownload(res.items[0]);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false });
        }
      })
      .catch(() => sendResponse({ ok: false }));
    return true; // async response
  }

  if (msg.type === "catch-x") {
    // The Catch button resolved the hovered tweet's media id — download the
    // matching HLS stream (already sniffed from the network) with the tweet title.
    const tabId = sender.tab && sender.tab.id;
    if (msg.title && msg.mediaId) noteXTitle(tabId, msg.mediaId, msg.title);
    const list = (tabId != null && mediaByTab.get(tabId)) || [];
    // Prefer an HLS master for this id; fall back to any stream sharing the id.
    const cands = list.filter((e) => xMediaId(e.url) === msg.mediaId && !e.url.startsWith("blob:"));
    const target = cands.find((e) => e.type === "hls") || cands.find((e) => e.type === "dash") || cands[0];
    if (target) {
      if (msg.title) target.title = msg.title;
      doDownload(target);
      sendResponse({ ok: true });
    } else {
      // The stream hasn't been sniffed yet (video not played) — tell the user.
      sendResponse({ ok: false });
    }
    return; // synchronous
  }

  if (msg.type === "probe-hls") {
    fetch(msg.url, { credentials: "include" })
      .then((r) => r.text())
      .then((text) => sendResponse({ variants: parseMasterVariants(text, msg.url) }))
      .catch(() => sendResponse({ variants: [] }));
    return true; // async response
  }

  if (msg.type === "resolve-link") {
    resolveLink(msg.url, msg.tabId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
    return true; // async response
  }

  if (msg.type === "subs-list") {
    listSubtitles(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
    return true; // async response
  }

  if (msg.type === "subs-get") {
    getSubtitle(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
    return true; // async response
  }

  if (msg.type === "grab-thumbnail") {
    grabThumbnail(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
    return true; // async response
  }

  switch (msg.type) {
    case "hls-progress":
      handleHlsProgress(msg);
      break;

    case "hls-ready":
      handleHlsReady(msg);
      break;

    case "hls-error":
      // Ignore a failure/cancel bubbling up from the OLD attempt while a retry is
      // restarting this id — otherwise it stomps the fresh "downloading" row.
      if (!restartingIds.has(msg.id)) notifyHlsError(msg.id, msg.error);
      break;

    case "job-canceled":
      // Same guard: the retry's own `job-cancel` makes the old attempt report
      // "canceled"; don't let that flip the row we just reset to downloading.
      if (!restartingIds.has(msg.id)) {
        patchDownload(msg.id, { status: "canceled", phase: null });
        finishJob(msg.id);
      }
      break;

    case "hls-phase":
      // Entering "converting" restarts the progress meter at 0 (fetch left it at
      // ~100%) so the "Processing… N%" bar climbs cleanly instead of snapping down.
      patchDownload(msg.id, msg.phase === "converting" ? { phase: msg.phase, progress: 0 } : { phase: msg.phase });
      relayToPopup({ type: "hls-converting-ui", id: msg.id });
      break;

    case "hls-warn":
      if (msg.warn === "convert-failed") {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Saved without conversion",
          message: "MP4 conversion failed — saved the raw stream instead. It still plays in VLC.",
        });
      } else if (msg.warn === "yt-split") {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Saved as separate video + audio files",
          message:
            "This capture was too large to merge in-browser, so the video and audio were saved as two files. Play them together in VLC, or merge losslessly with: ffmpeg -i video -i audio -c copy out.mp4",
        });
      } else if (msg.warn === "too-large-to-convert") {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Saved as .ts (too large for MP4)",
          message: "Over ~2GB can't be converted to MP4 in-browser. Saved the raw stream — it plays in VLC, or convert it with a desktop tool.",
        });
      }
      break;

    case "file-fallback": {
      // Accelerated download couldn't run (no range support) — do it normally.
      const entry = hlsJobs.get(msg.id) || { url: msg.url, type: "video" };
      hlsJobs.delete(msg.id);
      if (entry.tabId != null) {
        const list = mediaByTab.get(entry.tabId);
        updateBadge(entry.tabId, list ? list.length : 0);
      }
      normalDownload(entry, msg.filename);
      break;
    }

    case "get-media":
      sendResponse({
        media: mediaByTab.get(msg.tabId) || [],
        settings,
      });
      return; // synchronous response

    case "get-downloads":
      sendResponse({ downloads });
      return;

    case "clear-downloads":
      // Drop finished items; keep anything still active.
      downloads = downloads.filter((d) => d.status === "downloading" || d.status === "paused");
      persistDownloads();
      broadcastDownloads();
      break;

    case "pause-download":
      pauseDownload(msg.id);
      break;

    case "resume-download":
      resumeDownload(msg.id);
      break;

    case "cancel-download":
      cancelDownload(msg.id);
      break;

    case "retry-download":
      retryDownload(msg.id);
      break;

    case "set-priority":
      setDownloadPriority(msg.id);
      break;

    case "remove-download":
      removeDownload(msg.id);
      break;

    case "reveal-download":
      if (msg.dlId != null) {
        try {
          chrome.downloads.show(msg.dlId);
        } catch {}
      }
      break;

    case "video-playing":
      addMedia(sender.tab && sender.tab.id, {
        url: msg.src,
        source: msg.source || "page",
        title: msg.title,
        poster: msg.poster || null,
        redditId: msg.redditId || null,
      });
      break;

    case "x-media":
      // X/Twitter content script mapping a tweet's media id → a readable title,
      // so the sniffed HLS streams get named after their own tweets.
      noteXTitle(sender.tab && sender.tab.id, msg.mediaId, msg.title);
      break;

    case "youtube-here":
      // Content script is on a YouTube watch page; remember it for the popup's
      // capture card.
      ytNote(sender.tab && sender.tab.id, msg.videoId, msg.title);
      break;

    case "yt-status":
      // Popup asking what YouTube video (if any) is on a tab.
      sendResponse(ytTabs.get(msg.tabId) || null);
      return;

    case "yt-capture-start":
      ytCapture(msg.tabId, true, msg.rangeStart || 0, msg.rangeEnd || 0);
      break;

    case "yt-recapture": {
      // Re-run a failed/glitchy YouTube capture with its original params. Needs the
      // tab to still be on that video (the hook must be live there).
      const r = downloads.find((d) => d.id === msg.id);
      if (r && r.ytReq) {
        const { tabId, rangeStart, rangeEnd } = r.ytReq;
        removeDownload(msg.id); // drop the old row; the new capture makes a fresh one
        ytCapture(tabId, true, rangeStart || 0, rangeEnd || 0);
      }
      break;
    }

    case "yt-capture-finalize":
      ytFinalize(msg.tabId);
      break;

    case "yt-cap-status":
      ytOnStatus(msg);
      break;

    case "yt-cap-init":
    case "yt-cap-data":
    case "yt-cap-wipe":
      // Live capture stream (init segments / media fragments / restart wipes) —
      // forward to the offscreen store IN ORDER (see forwardToOffscreen).
      forwardToOffscreen(msg);
      break;

    case "yt-cap-done": {
      const cap = ytCaptures.get(msg.captureId);
      ytCaptures.delete(msg.captureId);
      setCaptureAdBlock(null, false); // buffering finished — lift the ad block
      const titled = msg.title && cleanTitle(msg.title) ? cleanTitle(msg.title) + ".mp4" : null;
      const filename = titled || (cap ? cap.filename : "youtube-video.mp4");
      if (cap && filename !== cap.filename) patchDownload(cap.recordId, { name: filename });
      // Backgrounded/app-switched captures stop early — flag the short file instead
      // of reporting a clean success.
      if (msg.incomplete && cap) {
        patchDownload(cap.recordId, {
          error: `stopped at ${msg.buffered || 0}s of ${msg.total || 0}s — keep the tab in front while capturing`,
        });
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Capture stopped early",
          message: `Only ~${msg.buffered || 0}s of ${msg.total || 0}s was captured. Keep the YouTube tab in the foreground while it downloads.`,
        });
      }
      // Rides the SAME ordered chain as the stream — `done` must arrive at the
      // offscreen store after the last fragment, never before.
      forwardToOffscreen({
        type: "yt-cap-done",
        captureId: msg.captureId,
        id: cap ? cap.recordId : null,
        filename,
        duration: msg.duration || 0,
        // The window the user asked for — the muxer trims the capture to it.
        // (All stream timing — track starts, keyframes, A/V alignment — is
        // computed offscreen from the shipped fragments themselves.)
        rangeStart: (cap && cap.rangeStart) || msg.rangeStart || 0,
        rangeEnd: (cap && cap.rangeEnd) || msg.rangeEnd || 0,
      });
      break;
    }

    case "download":
      if (msg.entry) doDownload(msg.entry);
      break;

    case "clear":
      forgetTab(msg.tabId);
      updateBadge(msg.tabId, 0);
      break;

    case "set-setting":
      settings[msg.key] = msg.value;
      chrome.storage.local.set({ settings });
      break;
  }
});
