// Video Catch — YouTube bridge (isolated content-script world)
//
// YouTube can't be downloaded the normal way (SABR + signature cipher). Instead
// we capture the media the player itself buffers, via the MAIN-world hook in
// yt-hook.js. This script is the bridge: it relays capture commands from the
// extension to the page, and ships the captured fMP4 bytes back to the
// background to be muxed into a clean MP4.

// Mirror the "Save captures as MP4" setting into page localStorage so the MAIN-
// world hook can read it synchronously at document_start (it has no chrome APIs).
// localStorage persists across loads, so after the first visit it's always ready;
// a change applies on the next page load.
function syncPreferMp4() {
  try {
    chrome.storage.local.get("settings").then((r) => {
      const on = !(r.settings && r.settings.captureMp4 === false); // default ON
      try {
        localStorage.setItem("vc_captureMp4", on ? "1" : "0");
      } catch {}
    });
  } catch {}
}
syncPreferMp4();
chrome.storage.onChanged.addListener((c) => {
  if (c.settings) syncPreferMp4();
});

function videoTitle() {
  // Shorts: the metadata <h1> lags a scroll behind; document.title tracks the
  // current short — use it so the Downloads row shows the right name.
  if (/^\/shorts\//.test(location.pathname)) {
    const d = document.title.replace(/\s*-\s*YouTube$/, "").trim();
    if (d && d.toLowerCase() !== "youtube") return d;
  }
  const h =
    document.querySelector(
      "ytd-watch-metadata h1 yt-formatted-string, h1.ytd-watch-metadata, #title h1, h1.title yt-formatted-string"
    ) || document.querySelector("h1");
  const t = h && h.textContent.trim();
  if (t) return t;
  const meta = document.querySelector('meta[name="title"]');
  if (meta && meta.content) return meta.content;
  return document.title.replace(/\s*-\s*YouTube$/, "");
}

function currentVideoId() {
  try {
    const u = new URL(location.href);
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

let lastId = null;
let lastTitle = "";
function announce() {
  const id = currentVideoId();
  if (!id) return;
  const title = videoTitle();
  // Re-announce when the title finally loads (it lags on a fresh watch page), not
  // only when the video id changes — otherwise the popup keeps a stale/empty name.
  if (id === lastId && title === lastTitle) return;
  lastId = id;
  lastTitle = title;
  send({ type: "youtube-here", videoId: id, title });
}

function send(msg) {
  try {
    chrome.runtime.sendMessage(msg);
  } catch {
    lastId = null;
  }
}

function pageCmd(cmd, extra) {
  window.postMessage({ source: "vc-cmd", cmd, ...(extra || {}) }, "*");
}

// Pending subtitle fetches: reqId -> sendResponse (the page replies async via a
// vc-evt "subsresult" window message).
const pendingSubs = new Map();
let subSeq = 0;

// --- relay capture events from the page hook → background ------------------
// The hook stamps every event with its captureId, so we just pass it through.

window.addEventListener("message", (e) => {
  // Only accept events posted by THIS window (the MAIN-world hook) — blocks
  // forged capture events from embedded iframes / other windows.
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.source !== "vc-evt") return;
  if (d.evt === "subsresult") {
    const cb = pendingSubs.get(d.reqId);
    if (cb) {
      pendingSubs.delete(d.reqId);
      try {
        cb({ ok: !!d.ok, text: d.text || "", fmt: d.fmt || "", error: d.error || "" });
      } catch {}
    }
    return;
  }
  switch (d.evt) {
    case "status":
    case "started":
    case "stopped":
    case "finalizing":
    case "overflow":
      send({ type: "yt-cap-status", captureId: d.captureId, evt: d.evt, video: d.video || 0, audio: d.audio || 0, pct: d.pct, overflow: !!d.overflow, ad: !!d.ad, title: d.title });
      break;
    case "error":
      send({ type: "yt-cap-status", captureId: d.captureId, evt: "error", reason: d.reason });
      break;
    case "tinit":
      // A track's codec config — streamed live during the capture.
      send({ type: "yt-cap-init", captureId: d.captureId, trackId: d.trackId, kind: d.kind, mime: d.mime, b64: d.b64 });
      break;
    case "tchunk":
      // One media fragment (with its tfdt decode-time ticks) — streamed live.
      send({ type: "yt-cap-data", captureId: d.captureId, trackId: d.trackId, kind: d.kind, mime: d.mime, t: d.t, b64: d.b64 });
      break;
    case "wipe":
      // The page restarted its stream (reload-from-0) — drop shipped data.
      send({ type: "yt-cap-wipe", captureId: d.captureId });
      break;
    case "done":
      send({
        type: "yt-cap-done",
        captureId: d.captureId,
        title: d.title,
        duration: d.duration || 0,
        incomplete: !!d.incomplete,
        buffered: d.buffered || 0,
        total: d.total || 0,
        rangeStart: d.rangeStart || 0,
        rangeEnd: d.rangeEnd || 0,
      });
      break;
  }
});

// --- commands from the popup/background → page hook ------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "yt-do-start") {
    pageCmd("start", {
      captureId: msg.captureId,
      auto: msg.auto,
      skipAds: msg.skipAds,
      rangeStart: msg.rangeStart || 0,
      rangeEnd: msg.rangeEnd || 0,
    });
    sendResponse({ ok: true });
  } else if (msg.type === "yt-do-status") {
    pageCmd("status");
    sendResponse({ ok: true });
  } else if (msg.type === "yt-do-finalize") {
    pageCmd("finalize", { captureId: msg.captureId });
    sendResponse({ ok: true });
  } else if (msg.type === "yt-do-stop") {
    pageCmd("stop", { captureId: msg.captureId });
    sendResponse({ ok: true });
  } else if (msg.type === "yt-do-pause") {
    pageCmd("pause", { captureId: msg.captureId });
    sendResponse({ ok: true });
  } else if (msg.type === "yt-do-resume") {
    pageCmd("resume", { captureId: msg.captureId });
    sendResponse({ ok: true });
  } else if (msg.type === "yt-fetch-subs") {
    // Ask the page (MAIN world) to fetch the caption track in its own context.
    const reqId = "subs-" + ++subSeq;
    pendingSubs.set(reqId, sendResponse);
    pageCmd("fetchsubs", { reqId, lang: msg.lang, kind: msg.kind, tlang: msg.tlang, url: msg.url });
    // Safety: never leave the background hanging if the page doesn't reply.
    setTimeout(() => {
      if (pendingSubs.has(reqId)) {
        pendingSubs.delete(reqId);
        try {
          sendResponse({ ok: false, error: "timeout" });
        } catch {}
      }
    }, 15000);
    return true; // async response
  }
  return; // synchronous
});

document.addEventListener("yt-navigate-finish", () => setTimeout(announce, 300), true);
window.addEventListener("popstate", () => setTimeout(announce, 500));
setInterval(announce, 4000);
announce();
