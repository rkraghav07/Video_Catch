// Tests the Instagram resolver's pure helpers from background.js (loaded for real
// in a vm with chrome/* mocked). The shortcode→media-id vector and the API shape
// were captured LIVE from instagram.com, so this guards the 2026 rewrite (the old
// ?__a=1 endpoint is dead; we now use /media/{id}/info/ + feed/reels_media).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const bg = (() => {
  const code = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const noop = () => {};
  const evt = () => ({ addListener: noop });
  const chrome = {
    runtime: { onMessage: evt(), sendMessage: () => Promise.resolve(), lastError: null, getURL: (p) => p },
    storage: { local: { get: () => Promise.resolve({}), set: noop }, onChanged: evt() },
    webRequest: { onBeforeRequest: evt(), onHeadersReceived: evt() },
    notifications: { onButtonClicked: evt(), onClicked: evt(), onClosed: evt(), create: noop, clear: noop },
    tabs: { onRemoved: evt(), onUpdated: evt(), get: noop, query: noop, sendMessage: noop },
    downloads: { download: noop, onChanged: evt() },
    action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve() },
    offscreen: { hasDocument: () => Promise.resolve(false), createDocument: () => Promise.resolve() },
  };
  const ctx = { chrome, URL, console, setTimeout, clearTimeout, TextEncoder, btoa, Date, Math, JSON, BigInt, fetch: () => Promise.reject(new Error("no net")) };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: "background.js" });
  return ctx;
})();

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`); }
};

// --- shortcode → media id (LIVE-verified vector) ---
check("shortcode DaQGBHwiGYQ → 3931668940023424528", bg.igShortcodeToMediaId("DaQGBHwiGYQ") === "3931668940023424528", bg.igShortcodeToMediaId("DaQGBHwiGYQ"));
check("shortcode 'B' → 1", bg.igShortcodeToMediaId("B") === "1");
check("shortcode 'BA' → 64", bg.igShortcodeToMediaId("BA") === "64");
check("rejects illegal char", bg.igShortcodeToMediaId("!!!") === null);

// --- igCollectVideos: single video item ---
const single = { video_versions: [{ url: "https://cdn/best.mp4", width: 720 }, { url: "https://cdn/small.mp4", width: 480 }] };
let acc = [];
bg.igCollectVideos(single, acc);
check("single video → picks first (best) version", acc.length === 1 && acc[0] === "https://cdn/best.mp4", JSON.stringify(acc));

// --- igCollectVideos: image-only item (no video) ---
acc = [];
bg.igCollectVideos({ image_versions2: { candidates: [{ url: "x.jpg" }] } }, acc);
check("image-only → no urls", acc.length === 0);

// --- igCollectVideos: carousel/album with mixed children ---
const carousel = {
  carousel_media: [
    { video_versions: [{ url: "https://cdn/clip1.mp4" }] },
    { image_versions2: { candidates: [{ url: "photo.jpg" }] } },
    { video_versions: [{ url: "https://cdn/clip2.mp4" }] },
  ],
};
acc = [];
bg.igCollectVideos(carousel, acc);
check("carousel → collects only its video children, in order", acc.length === 2 && acc[0] === "https://cdn/clip1.mp4" && acc[1] === "https://cdn/clip2.mp4", JSON.stringify(acc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
