// Unit-tests the pure parsing/util logic from offscreen.js and background.js by
// running them in a vm with stubbed chrome APIs, then validating against the
// real Mux test playlist. Run: node test/unit.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadModule(file, sandbox) {
  const code = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx, { filename: file });
  return ctx;
}

// Minimal chrome stub so top-level addListener/get calls don't throw.
function chromeStub() {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  return {
    runtime: { onMessage: listener, sendMessage: noop, getURL: (p) => p, lastError: null },
    webRequest: { onBeforeRequest: listener, onHeadersReceived: listener },
    tabs: { onRemoved: listener, onUpdated: listener, get: noop, query: noop },
    downloads: { onChanged: listener, onCreated: listener, download: noop, show: noop },
    storage: {
      local: { get: () => Promise.resolve({}), set: noop },
      onChanged: listener,
    },
    notifications: { onButtonClicked: listener, onClicked: listener, onClosed: listener, create: noop },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    offscreen: { hasDocument: () => Promise.resolve(false), createDocument: noop },
  };
}

let pass = 0,
  fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

(async () => {
  // ---- offscreen.js parsing ----
  const off = loadModule("offscreen.js", {
    chrome: chromeStub(),
    self: {},
    document: { addEventListener: () => {} },
    URL,
    crypto: globalThis.crypto,
    Blob: globalThis.Blob,
    fetch: globalThis.fetch,
    console,
    setTimeout,
  });

  const master = await (await fetch("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8")).text();
  check("offscreen.isMaster detects master", off.isMaster(master) === true);

  const parsed = off.parseMaster(master, "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8");
  check("parseMaster finds variants", parsed.variants.length > 0, `${parsed.variants.length}`);
  check("variants sorted desc by height", parsed.variants.every((v, i, a) => i === 0 || a[i - 1].height >= v.height));
  check("variant urls absolute", parsed.variants.every((v) => v.url.startsWith("http")));

  const mediaUrl = parsed.variants[parsed.variants.length - 1].url; // smallest
  const mediaText = await (await fetch(mediaUrl)).text();
  check("media playlist is not master", off.isMaster(mediaText) === false);
  const media = off.parseMedia(mediaText, mediaUrl);
  check("parseMedia finds segments", media.segments.length > 0, `${media.segments.length}`);
  check("segment urls absolute", media.segments.every((s) => s.url.startsWith("http")));

  // ---- background.js util/logic ----
  const bg = loadModule("background.js", {
    chrome: chromeStub(),
    URL,
    console,
    setTimeout,
    Date,
    Map,
    Set,
  });

  check("classify hls", bg.classify("https://x/master.m3u8") === "hls");
  check("classify dash", bg.classify("https://x/manifest.mpd") === "dash");
  check("classify video", bg.classify("https://x/movie.mp4") === "video");

  check("masterScore prefers master", bg.masterScore("https://x/master.m3u8") > bg.masterScore("https://x/index-v1-a1.m3u8"));
  check(
    "groupKey same folder collapses",
    bg.groupKey("https://x/a/master.m3u8") === bg.groupKey("https://x/a/index-v1.m3u8")
  );
  check(
    "groupKey different folder differs",
    bg.groupKey("https://x/a/master.m3u8") !== bg.groupKey("https://x/b/master.m3u8")
  );

  check("cleanTitle strips YouTube suffix", bg.cleanTitle("Cool Video - YouTube") === "Cool Video");
  check("suggestFilename uses title + mp4", bg.suggestFilename({ title: "My Clip", type: "video" }) === "My Clip.mp4");
  check("modeName audio→mp3", bg.modeName({ title: "Song", type: "hls", mode: "audio" }) === "Song.mp3");
  check("modeName gif", bg.modeName({ title: "Loop", type: "hls", mode: "gif" }) === "Loop.gif");
  check("fmtSize MB", /MB$/.test(bg.fmtSize(5 * 1024 * 1024)));

  const variants = bg.parseMasterVariants(master, "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8");
  check("bg.parseMasterVariants finds qualities", variants.length > 0, `${variants.length}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
