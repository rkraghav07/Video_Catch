// Video Catch — content script
// 1) reports playing <video> elements so the background can offer a download
// 2) shows a small "Catch" button floating over a video when you hover it
//
// Real players (YouTube, etc.) stack click-capture <div>s ON TOP of the
// <video>, so a plain "mouseover the video" never fires. We instead track the
// pointer and use elementsFromPoint() to find a <video> *beneath* the overlays.

// The video's own poster, or the page's og:image / twitter:image as a fallback —
// used for the "grab thumbnail" button in the popup.
function posterFor(video) {
  const abs = (s) => {
    try {
      return new URL(s, location.href).href;
    } catch {
      return "";
    }
  };
  if (video.poster) return abs(video.poster);
  const og = document.querySelector(
    'meta[property="og:image"], meta[name="og:image"], meta[property="og:image:url"], meta[name="twitter:image"]'
  );
  if (og && og.content) return abs(og.content);
  return "";
}

function report(video) {
  const src = video.currentSrc || video.src;
  if (!src) return;
  try {
    chrome.runtime.sendMessage({ type: "video-playing", src, title: document.title, poster: posterFor(video) });
  } catch (e) {
    /* extension reloading */
  }
}

document.addEventListener(
  "play",
  (e) => {
    if (e.target instanceof HTMLVideoElement) report(e.target);
  },
  true
);

window.addEventListener("load", () => {
  document.querySelectorAll("video").forEach((v) => {
    if (!v.paused && !v.ended) report(v);
  });
});

// --- Reddit: surface the ready-made progressive MP4 -------------------------
// Reddit plays video via <shreddit-player> (a web component whose <video> lives
// in a shadow root, so the normal detectors miss it). The element carries a
// `packaged-media-json` attribute with DIRECT progressive MP4 URLs (audio already
// muxed) plus the real `post-title`. Using those avoids Reddit's HLS/CMAF stream —
// which fails to remux to MP4 — and names the file with the post headline instead
// of the generic page title. Falls back to the HLS master only if no packaged MP4.
function reportReddit() {
  if (!/(^|\.)reddit\.com$/i.test(location.hostname)) return;
  document.querySelectorAll("shreddit-player, shreddit-player-2").forEach((p) => {
    try {
      const title = (p.getAttribute("post-title") || "").trim() || document.title;
      const poster = p.getAttribute("poster") || "";
      // The v.redd.it media id — used to fetch the separate audio track (Reddit's
      // packaged MP4s are video-only). It appears in preview/caption/src attrs.
      const idm = ((p.getAttribute("preview") || "") + " " + (p.getAttribute("caption-url") || "") + " " + (p.getAttribute("src") || "")).match(
        /v\.redd\.it\/([A-Za-z0-9]+)/
      );
      const redditId = idm ? idm[1] : null;

      // Prefer the ready-made progressive MP4 (video only) — the background fetches
      // the matching audio and muxes them.
      let best = null;
      const raw = p.getAttribute("packaged-media-json");
      if (raw) {
        const j = JSON.parse(raw);
        const perms = (j.playbackMp4s && j.playbackMp4s.permutations) || [];
        for (const x of perms) {
          const s = x && x.source;
          const h = (s && s.dimensions && s.dimensions.height) || 0;
          if (s && s.url && (!best || h > best.h)) best = { url: s.url, h };
        }
      }
      if (best) {
        chrome.runtime.sendMessage({ type: "video-playing", src: best.url, title, poster, source: "reddit", redditId });
        return;
      }
      // No packaged MP4 — fall back to the HLS master (has audio+video already).
      const master = p.getAttribute("src");
      if (master && /\.m3u8/i.test(master)) {
        chrome.runtime.sendMessage({ type: "video-playing", src: master, title, poster, source: "reddit" });
      }
    } catch (e) {
      /* extension reloading / bad JSON */
    }
  });
}

// Resolve the specific hovered Instagram video → its post URL, so the Catch button
// works on the FEED too (a feed video isn't on a /p/ page, so the popup can't
// auto-resolve it). Background then hits IG's media API to get the playable MP4.
function igVideoInfo(v) {
  if (!v || !/(^|\.)instagram\.com$/i.test(location.hostname)) return null;
  const mk = (seg, code) => ({ url: `https://www.instagram.com/${seg.toLowerCase()}/${code}/` });
  const LINK = 'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]';
  const fromHref = (href) => {
    const m = (href || "").match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    return m ? mk(m[1], m[2]) : null;
  };
  // Already on a post/reel/tv page → the URL IS the post.
  const pageM = location.pathname.match(/^\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (pageM) return mk(pageM[1], pageM[2]);
  // Feed: the video's own <article> holds its permalink. Use closest() — the link
  // sits ~16 levels up, so a fixed-depth manual climb missed it (v2.14.1 regression).
  const art = v.closest && v.closest("article");
  if (art) {
    const a = art.querySelector(LINK);
    if (a) {
      const r = fromHref(a.getAttribute("href"));
      if (r) return r;
    }
  }
  // Fallback: nearest ancestor (deep) that contains a post link — but its OWN, not
  // the first post on the whole page (that was the wrong-video bug).
  let node = v.parentElement;
  for (let i = 0; i < 30 && node; i++) {
    const a = node.querySelector && node.querySelector(LINK);
    if (a) {
      const r = fromHref(a.getAttribute("href"));
      if (r) return r;
    }
    node = node.parentElement;
  }
  return null;
}

// Resolve the specific hovered <video> → its shreddit-player's downloadable URL +
// real title, so the Catch button grabs exactly that clip (not a tab-wide guess).
function redditVideoInfo(v) {
  if (!v || !/(^|\.)reddit\.com$/i.test(location.hostname)) return null;
  let player = null;
  let node = v;
  for (let i = 0; i < 5 && node; i++) {
    const root = node.getRootNode();
    const host = root instanceof ShadowRoot ? root.host : null;
    if (host && /^shreddit-player/i.test(host.tagName || "")) {
      player = host;
      break;
    }
    node = host;
  }
  if (!player) return null;
  const title = (player.getAttribute("post-title") || "").trim() || document.title;
  let url = null;
  try {
    const j = JSON.parse(player.getAttribute("packaged-media-json"));
    const perms = (j.playbackMp4s && j.playbackMp4s.permutations) || [];
    let best = null;
    for (const x of perms) {
      const s = x && x.source;
      const h = (s && s.dimensions && s.dimensions.height) || 0;
      if (s && s.url && (!best || h > best.h)) best = { url: s.url, h };
    }
    if (best) url = best.url;
  } catch {}
  if (!url) {
    const m = player.getAttribute("src");
    if (m && /\.m3u8/i.test(m)) url = m;
  }
  if (!url) return null;
  return { url, title };
}

// --- X / Twitter --------------------------------------------------------------
// X plays video via HLS (a blob: MediaSource on the <video>, so the element's src
// isn't downloadable) — the real, grabbable stream is the video.twimg.com .m3u8
// the network sniffer catches. Every X video has a numeric MEDIA ID that appears
// in BOTH the HLS URL (…/amplify_video/<id>/… or …/ext_tw_video/<id>/…) and the
// video's poster thumbnail (…/amplify_video_thumb/<id>/…). We use that shared id
// to (a) name each stream after its own tweet and (b) let the Catch button grab
// exactly the hovered video instead of a tab-wide guess (the reported bug).

function isX() {
  return /(^|\.)(x|twitter)\.com$/i.test(location.hostname);
}

// The tweet media id from any twimg URL (HLS, mp4, or a *_thumb poster).
function xIdFromUrl(s) {
  const m = (s || "").match(/(?:amplify_video|ext_tw_video|tweet_video)(?:_thumb)?\/(\d+)/);
  return m ? m[1] : null;
}

// A readable name for a hovered/scanned X <video>: "Author - tweet text…".
function xTitleFor(v) {
  const art = v && v.closest && v.closest("article");
  if (!art) return null;
  const authEl = art.querySelector('[data-testid="User-Name"]');
  const textEl = art.querySelector('[data-testid="tweetText"]');
  let name = (authEl && authEl.textContent) || "";
  name = name.split("@")[0].replace(/\s+/g, " ").trim(); // display name, drop the @handle
  const text = ((textEl && textEl.textContent) || "").replace(/\s+/g, " ").trim();
  const t = [name, text].filter(Boolean).join(" - ").slice(0, 80).trim();
  return t || null;
}

// The hovered video's media id (from its poster) + tweet title, so the Catch
// button downloads exactly that clip.
function xVideoInfo(v) {
  if (!v || !isX()) return null;
  let id = xIdFromUrl(v.poster);
  if (!id) {
    const art = v.closest && v.closest("article");
    const img = art && art.querySelector('img[src*="_video_thumb/"], img[src*="tweet_video_thumb/"]');
    if (img) id = xIdFromUrl(img.getAttribute("src"));
  }
  if (!id) return null;
  return { id, title: xTitleFor(v) };
}

// Report every visible tweet video's id→title so the background can NAME the
// network-sniffed HLS streams after their own tweets (instead of "Home / X").
function reportX() {
  if (!isX()) return;
  document.querySelectorAll("video").forEach((v) => {
    try {
      const info = xVideoInfo(v);
      if (info && info.title) {
        chrome.runtime.sendMessage({ type: "x-media", mediaId: info.id, title: info.title });
      }
    } catch {}
  });
}

if (/(^|\.)reddit\.com$/i.test(location.hostname)) {
  const kick = () => reportReddit();
  window.addEventListener("load", kick);
  // Reddit is a SPA and the player mounts lazily — re-scan a few times + on nav.
  setInterval(kick, 3000);
  document.addEventListener("click", () => setTimeout(kick, 800), true);
  kick();
}

if (isX()) {
  const kick = () => reportX();
  window.addEventListener("load", kick);
  setInterval(kick, 3000); // SPA feed — new tweets/videos mount as you scroll
  document.addEventListener("scroll", () => setTimeout(kick, 600), true);
  kick();
}

// The popup's Refresh button asks all frames to re-scan the current page.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "rescan") return;
  try {
    reportReddit();
    reportX();
    document.querySelectorAll("video").forEach((v) => {
      if (!v.paused && !v.ended) report(v);
    });
  } catch {}
});

// --- in-video overlay button ----------------------------------------------

let overlayEnabled = true;
chrome.storage.local.get("settings").then((r) => {
  if (r.settings && r.settings.overlayButton === false) overlayEnabled = false;
});
chrome.storage.onChanged.addListener((c) => {
  if (c.settings) overlayEnabled = !(c.settings.newValue && c.settings.newValue.overlayButton === false);
  if (!overlayEnabled) hideBtn();
});

let wrap = null; // container holding the Catch button + a ✕ dismiss
let btn = null;
let activeVideo = null;
let hideTimer = null;
let lastMove = 0;
let sessionDismissed = false; // ✕ hides it until the page is reloaded

function makeBtn() {
  if (wrap && wrap.isConnected) return btn;
  wrap = document.createElement("div");
  Object.assign(wrap.style, {
    position: "fixed",
    zIndex: "2147483647",
    display: "none",
    alignItems: "center",
    gap: "4px",
    pointerEvents: "auto",
  });

  btn = document.createElement("button");
  btn.textContent = "⬇ Catch";
  Object.assign(btn.style, {
    padding: "7px 12px",
    borderRadius: "9px",
    border: "none",
    cursor: "pointer",
    background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
    color: "#fff",
    font: "700 12px system-ui,-apple-system,sans-serif",
    boxShadow: "0 3px 12px rgba(0,0,0,.4)",
    transition: "transform .12s",
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.textContent = "Catching…";
    // Download the SPECIFIC video under the pointer (important on feeds with many
    // videos — the old tab-level "best guess" grabbed the wrong/stale one, and on
    // Instagram the only detectable source is an un-downloadable blob).
    const onIG = /(^|\.)instagram\.com$/i.test(location.hostname);
    const rd = redditVideoInfo(activeVideo);
    const ig = rd ? null : igVideoInfo(activeVideo);
    const xi = !rd && !ig && isX() ? xVideoInfo(activeVideo) : null;
    let message = { type: "overlay-download" };
    if (rd) message = { type: "catch-reddit", url: rd.url, title: rd.title };
    else if (ig) message = { type: "catch-instagram", url: ig.url };
    else if (xi) message = { type: "catch-x", mediaId: xi.id, title: xi.title };
    else if (onIG || isX()) {
      // Couldn't identify THIS video's post (e.g. a sponsored/ad tile). Do NOT fall
      // back to the tab-level guess — on a feed that grabs a different video (the
      // reported X bug).
      btn.textContent = "Can't grab this";
      setTimeout(hideBtn, 1800);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (res) => {
        btn.textContent = res && res.ok ? "✓ Sent" : "▶ Play it first";
        setTimeout(hideBtn, 1800);
      });
    } catch {
      hideBtn();
    }
  });

  // ✕ — instantly hide it (until reload). The permanent off-switch is the
  // "In-video button" toggle in the extension's settings.
  const x = document.createElement("button");
  x.textContent = "✕";
  x.title = "Hide the Catch button (turn it off for good in Settings)";
  Object.assign(x.style, {
    width: "22px",
    height: "28px",
    borderRadius: "8px",
    border: "none",
    cursor: "pointer",
    background: "rgba(15,23,42,.78)",
    color: "#fff",
    font: "700 11px system-ui,sans-serif",
    boxShadow: "0 3px 12px rgba(0,0,0,.4)",
  });
  x.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    sessionDismissed = true;
    hideBtn();
  });

  wrap.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  wrap.addEventListener("mouseleave", scheduleHide);

  wrap.append(btn, x);
  mountBtn();
  return btn;
}

// Append into the fullscreen element when one is active (a position:fixed node
// outside the fullscreen subtree is invisible); otherwise into <body>.
function mountBtn() {
  if (!wrap) return;
  const host = document.fullscreenElement || document.body || document.documentElement;
  if (wrap.parentElement !== host) host.appendChild(wrap);
}

// Find the largest <video> under the pointer, looking *through* overlay layers
// AND into shadow roots (so the button shows on web-component players like
// Reddit's <shreddit-player>). elementsFromPoint stops at a shadow host, so when
// we hit one we descend into its shadow root at the same point — cheap and exact,
// no full-document scan.
function videoAt(x, y) {
  let best = null;
  const consider = (v) => {
    if (!(v instanceof HTMLVideoElement)) return;
    const r = v.getBoundingClientRect();
    if (r.width < 160 || r.height < 90) return;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
    if (!best || r.width * r.height > best._area) {
      best = v;
      best._area = r.width * r.height;
    }
  };
  const scan = (el) => {
    if (el instanceof HTMLVideoElement) consider(el);
    else if (el.querySelector) {
      const v = el.querySelector("video");
      if (v) consider(v);
    }
  };
  const descend = (root, depth) => {
    if (depth > 8 || !root.elementFromPoint) return;
    const el = root.elementFromPoint(x, y);
    if (!el) return;
    scan(el);
    if (el.shadowRoot) descend(el.shadowRoot, depth + 1);
  };
  for (const el of document.elementsFromPoint(x, y)) {
    scan(el);
    if (el.shadowRoot) descend(el.shadowRoot, 0);
  }
  return best;
}

let btnVideo = null; // which video the (single, shared) button currently represents
function showBtnFor(video) {
  if (!overlayEnabled || sessionDismissed || !video) return;
  const r = video.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.width < 160 || r.height < 90) return hideBtn();
  makeBtn();
  mountBtn();
  // The button is one shared element repositioned over the hovered video — reset
  // its label when it moves to a DIFFERENT video, else a prior "✓ Sent" lingers
  // and looks like every video was sent.
  if (video !== btnVideo) {
    btnVideo = video;
    btn.textContent = "⬇ Catch";
    btn.disabled = false;
  }
  wrap.style.display = "flex";
  // measure after display so offsetWidth is correct
  wrap.style.top = Math.max(r.top + 12, 8) + "px";
  wrap.style.left = r.right - wrap.offsetWidth - 12 + "px";
}

function hideBtn() {
  if (wrap) wrap.style.display = "none";
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideBtn, 2800);
}

// Track the pointer (throttled) and reveal the button over whatever video is
// underneath — even if a transparent player UI sits on top of it.
document.addEventListener(
  "pointermove",
  (e) => {
    if (!overlayEnabled) return;
    const now = e.timeStamp || performance.now();
    if (now - lastMove < 120) return; // throttle
    lastMove = now;
    const v = videoAt(e.clientX, e.clientY);
    if (!v) return;
    activeVideo = v;
    // Only reveal when the pointer is near the TOP of the video (where the
    // button sits). This keeps it out of the way while you're just watching.
    const r = v.getBoundingClientRect();
    if (e.clientY <= r.top + Math.max(64, r.height * 0.28)) {
      showBtnFor(v);
      scheduleHide();
    }
  },
  true
);

function btnVisible() {
  return wrap && wrap.style.display !== "none";
}

document.addEventListener("fullscreenchange", () => {
  if (btnVisible()) {
    mountBtn();
    if (activeVideo) showBtnFor(activeVideo);
  }
});

addEventListener(
  "scroll",
  () => {
    if (activeVideo && btnVisible()) showBtnFor(activeVideo);
  },
  true
);
addEventListener("resize", () => {
  if (activeVideo && btnVisible()) showBtnFor(activeVideo);
});
