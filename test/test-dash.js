// Tests the DASH (.mpd) segment-generation logic from offscreen.js without a DOM.
// We load the real functions in a vm and feed dashSegmentsFromTemplate() mock
// elements, so the high-risk parts (ISO duration, $Number%04d$ templating,
// SegmentTimeline expansion + repeats, BaseURL resolution) are validated for real.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const off = (() => {
  const code = fs.readFileSync(path.join(__dirname, "..", "offscreen.js"), "utf8");
  const ctx = vm.createContext({
    chrome: { runtime: { onMessage: { addListener() {} }, getURL: (p) => p }, storage: { local: { get: () => Promise.resolve({}) } } },
    self: {}, document: { addEventListener() {} }, URL, console, setTimeout,
  });
  vm.runInContext(code, ctx, { filename: "offscreen.js" });
  return ctx;
})();

// Minimal DOM-ish mock: localName, getAttribute, children, getElementsByTagNameNS.
function E(localName, attrs = {}, children = []) {
  return {
    localName,
    children,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    getElementsByTagNameNS(ns, name) {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (name === "*" || c.localName === name) out.push(c); walk(c); } };
      walk(this);
      return out;
    },
  };
}

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`); }
};

// --- parseIsoDuration ---
check("ISO PT1M0S = 60", off.parseIsoDuration("PT1M0.00S") === 60);
check("ISO PT1H2M3S = 3723", off.parseIsoDuration("PT1H2M3S") === 3723);
check("ISO PT0H0M30.5S = 30.5", off.parseIsoDuration("PT0H0M30.5S") === 30.5);
check("ISO empty = 0", off.parseIsoDuration("") === 0);

// --- fillDashTemplate ---
check("tmpl RepresentationID", off.fillDashTemplate("init-$RepresentationID$.m4s", "720", 0, 0, 0) === "init-720.m4s");
check("tmpl Number plain", off.fillDashTemplate("seg-$Number$.m4s", "x", 7, 0, 0) === "seg-7.m4s");
check("tmpl Number padded %04d", off.fillDashTemplate("seg-$Number%04d$.m4s", "x", 7, 0, 0) === "seg-0007.m4s");
check("tmpl Time", off.fillDashTemplate("seg-$Time$.m4s", "x", 0, 12000, 0) === "seg-12000.m4s");
check("tmpl Bandwidth + escaped $$", off.fillDashTemplate("$Bandwidth$-$$.m4s", "x", 0, 0, 800000) === "800000-$.m4s");

// --- dashSegmentsFromTemplate: SegmentTimeline with repeat ---
{
  const base = "https://cdn.pw.live/lectures/lec1/manifest.mpd";
  const timeline = E("SegmentTimeline", {}, [E("S", { t: "0", d: "6000", r: "9" })]); // 10 segs
  const st = E("SegmentTemplate", {
    timescale: "1000", startNumber: "1",
    initialization: "v-$RepresentationID$-init.m4s",
    media: "v-$RepresentationID$-$Number%04d$.m4s",
  }, [timeline]);
  const out = off.dashSegmentsFromTemplate(st, base, "720", "2500000", 60);
  check("timeline: 10 segments", out.segments.length === 10, `${out.segments.length}`);
  check("timeline: init resolved", out.map === "https://cdn.pw.live/lectures/lec1/v-720-init.m4s", out.map);
  check("timeline: first seg padded+resolved", out.segments[0].url === "https://cdn.pw.live/lectures/lec1/v-720-0001.m4s", out.segments[0].url);
  check("timeline: last seg = 0010", out.segments[9].url.endsWith("v-720-0010.m4s"), out.segments[9].url);
  check("timeline: seq numbers 1..10", out.segments[0].seq === 1 && out.segments[9].seq === 10);
}

// --- dashSegmentsFromTemplate: duration-based (no timeline) ---
{
  const base = "https://cdn.pw.live/a/manifest.mpd";
  const st = E("SegmentTemplate", {
    timescale: "1000", duration: "6000", startNumber: "1",
    initialization: "a-init.m4s", media: "a-$Number$.m4s",
  }, []);
  const out = off.dashSegmentsFromTemplate(st, base, "audio", "128000", 60); // 60s / 6s = 10
  check("duration: 10 segments", out.segments.length === 10, `${out.segments.length}`);
  check("duration: init resolved", out.map === "https://cdn.pw.live/a/a-init.m4s", out.map);
  check("duration: first seg", out.segments[0].url === "https://cdn.pw.live/a/a-1.m4s", out.segments[0].url);
  check("duration: last seg = a-10", out.segments[9].url.endsWith("a-10.m4s"), out.segments[9].url);
}

// --- SegmentTimeline with negative r (until end) ---
{
  const timeline = E("SegmentTimeline", {}, [E("S", { t: "0", d: "5000", r: "-1" })]); // d=5s, total=20s → 4
  const st = E("SegmentTemplate", { timescale: "1000", startNumber: "1", media: "s$Number$.m4s" }, [timeline]);
  const out = off.dashSegmentsFromTemplate(st, "https://x/m.mpd", "v", "0", 20);
  check("negative r fills to end (4 segs)", out.segments.length === 4, `${out.segments.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
