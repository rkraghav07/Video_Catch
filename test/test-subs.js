// Tests the subtitle/transcript parsing + conversion logic from background.js.
// Loads the REAL functions in a vm (with chrome/* mocked) and runs them against
// representative WebVTT, SubRip, YouTube timed-XML, TTML and auto-caption inputs,
// plus the captionTracks JSON extractor — so we validate the actual shipped code
// without needing the loaded extension.
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
  const ctx = {
    chrome, URL, console, setTimeout, clearTimeout, TextEncoder, btoa, Date, Math, JSON,
    fetch: () => Promise.reject(new Error("no network in test")),
  };
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

// --- time parsing / formatting ---
check("parseCueTime HH:MM:SS.mmm", bg.parseCueTime("01:02:03.500") === 3723.5);
check("parseCueTime MM:SS,mmm (srt comma)", bg.parseCueTime("00:30,250") === 30.25);
check("fmtCueTime srt sep", bg.fmtCueTime(3723.5, ",") === "01:02:03,500");
check("fmtCueTime vtt sep", bg.fmtCueTime(30.25, ".") === "00:00:30,250".replace(",", "."));
check("fmtCueTime clamps negative", bg.fmtCueTime(-5, ".") === "00:00:00.000");

// --- entity decode + tag strip ---
check("decodeEntities amp/quot/num", bg.decodeEntities("a &amp; b &quot;c&quot; &#39;d&#39;") === `a & b "c" 'd'`);
check("stripTags removes vtt tags", bg.stripTags("<c>hi</c> <00:00:01.000>there") === "hi there");

// --- WebVTT parsing ---
const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Hello world

00:00:04.500 --> 00:00:06.000
Second &amp; line
<c>tagged</c> text
`;
const vttCues = bg.parseVtt(VTT);
check("VTT cue count", vttCues.length === 2, JSON.stringify(vttCues));
check("VTT first cue text", vttCues[0].text === "Hello world");
check("VTT decodes entity + strips tag", vttCues[1].text === "Second & line\ntagged text", JSON.stringify(vttCues[1]));
check("VTT cue times", vttCues[0].start === 1 && vttCues[0].end === 3);
check("VTT skips WEBVTT header block", !vttCues.some((c) => /WEBVTT/.test(c.text)));

// --- SubRip (.srt) parsed by the same VTT block parser (comma timestamps) ---
const SRT = `1
00:00:00,000 --> 00:00:02,000
Line one

2
00:00:02,000 --> 00:00:04,000
Line two`;
const srtCues = bg.parseSubtitles(SRT, "srt");
check("SRT cue count", srtCues.length === 2);
check("SRT comma time parsed", srtCues[1].start === 2 && srtCues[1].end === 4);

// --- YouTube srv1 timed XML ---
const XML = `<?xml version="1.0"?><transcript><text start="0" dur="1.5">Hi &amp; bye</text><text start="1.5" dur="2">next</text></transcript>`;
const xmlCues = bg.parseSubtitles(XML, "xml");
check("timed-XML cue count", xmlCues.length === 2);
check("timed-XML decodes + timing", xmlCues[0].text === "Hi & bye" && xmlCues[0].end === 1.5);

// --- TTML <p begin end> ---
const TTML = `<tt><body><div><p begin="00:00:01.000" end="00:00:02.500">one<br/>two</p></div></body></tt>`;
const ttmlCues = bg.parseSubtitles(TTML, "ttml");
check("TTML cue count", ttmlCues.length === 1);
check("TTML begin/end + <br>", ttmlCues[0].start === 1 && ttmlCues[0].end === 2.5 && ttmlCues[0].text === "one\ntwo");

// --- emit SRT / VTT ---
const srtOut = bg.cuesToSrt(vttCues);
check("toSrt numbers cues", /^1\n00:00:01,000 --> 00:00:03,000\nHello world/.test(srtOut), srtOut);
const vttOut = bg.cuesToVtt(vttCues);
check("toVtt has WEBVTT header + dot times", vttOut.startsWith("WEBVTT\n\n") && /00:00:01\.000 --> 00:00:03\.000/.test(vttOut));

// --- plain-text transcript dedupes rolling auto-captions ---
const ROLLING = `WEBVTT

00:00:00.000 --> 00:00:01.000
the quick

00:00:01.000 --> 00:00:02.000
the quick brown

00:00:02.000 --> 00:00:03.000
the quick brown fox

00:00:03.000 --> 00:00:04.000
jumps over
`;
const txt = bg.cuesToTxt(bg.parseVtt(ROLLING));
check("transcript collapses rolling window", txt === "the quick brown fox\njumps over\n", JSON.stringify(txt));

// --- convertSubs dispatcher ---
check("convertSubs srt", bg.convertSubs(VTT, "vtt", "srt").ext === "srt");
check("convertSubs vtt mime", bg.convertSubs(VTT, "vtt", "vtt").mime === "text/vtt");
check("convertSubs txt", bg.convertSubs(VTT, "vtt", "txt").ext === "txt");
check("convertSubs empty → null", bg.convertSubs("not subtitles at all", "", "srt") === null);

// --- subExt ---
check("subExt vtt", bg.subExt("https://x/y.vtt?a=1") === "vtt");
check("subExt srv3 → xml", bg.subExt("https://x/api/timedtext?fmt=srv3&v.srv3") === "xml" || bg.subExt("https://x/cc.srv3") === "xml");
check("subExt none", bg.subExt("https://x/y") === "");

// --- extractJsonArray (captionTracks out of ytInitialPlayerResponse blob) ---
const PLAYER = `var x={"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://yt/api/timedtext?v=ABC\\u0026lang=en","name":{"simpleText":"English"},"languageCode":"en","kind":"asr","isTranslatable":true},{"baseUrl":"https://yt/t?lang=hi","name":{"runs":[{"text":"Hindi"}]},"languageCode":"hi"}],"translationLanguages":[{"languageCode":"fr","languageName":{"simpleText":"French"}}]}}};`;
const arr = bg.extractJsonArray(PLAYER, "captionTracks");
const tracks = JSON.parse(arr);
check("extractJsonArray finds full array", Array.isArray(tracks) && tracks.length === 2, arr);
check("captionTrack baseUrl decoded by JSON.parse (\\u0026→&)", tracks[0].baseUrl === "https://yt/api/timedtext?v=ABC&lang=en");
check("ytName simpleText", bg.ytName(tracks[0].name, "x") === "English");
check("ytName runs[].text", bg.ytName(tracks[1].name, "x") === "Hindi");
check("ytName fallback", bg.ytName(null, "fallback") === "fallback");
const tl = bg.extractJsonArray(PLAYER, "translationLanguages");
check("extractJsonArray translationLanguages", JSON.parse(tl)[0].languageCode === "fr");
check("extractJsonArray missing key → null", bg.extractJsonArray(PLAYER, "nopeNotHere") === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
