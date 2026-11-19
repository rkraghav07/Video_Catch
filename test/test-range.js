// Tests the capture-range (clip window) logic: the coverage math that decides
// when a range capture is complete, the window clamping, and the popup's time
// parse/format helpers. These are browser-side functions (yt-hook.js IIFE and
// popup.js DOM code) that can't be vm-loaded, so the exact algorithms are
// mirrored here — keep them in sync if the originals change.

let pass = 0;
let fail = 0;
function check(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ok  " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (got !== undefined ? "  → got: " + got : ""));
  }
}

// --- mirror of yt-hook.js -------------------------------------------------
const RANGE_LEAD_IN = 6;
function capStart(state) {
  return state.rangeEnd > 0 ? Math.max(0, state.rangeStart - RANGE_LEAD_IN) : 0;
}
function capStop(state, dur) {
  return state.rangeEnd > 0 ? Math.min(dur, state.rangeEnd) : dur;
}
// Merge overlapping/touching ranges (addCovered's union step).
function mergeCovered(ranges) {
  if (!ranges.length) return [];
  const sorted = ranges.map((r) => r.slice()).sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    const last = merged[merged.length - 1];
    if (r[0] <= last[1] + 0.5) last[1] = Math.max(last[1], r[1]);
    else merged.push(r.slice());
  }
  return merged;
}
function coveredEndOf(ranges, from = 0) {
  let end = from;
  for (const r of ranges) {
    if (r[1] < from) continue;
    if (r[0] <= end + 0.5) end = Math.max(end, r[1]);
    else break;
  }
  return end;
}

// --- mirror of popup.js ---------------------------------------------------
function parseTime(str) {
  if (!str) return 0;
  const parts = String(str).trim().split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

// === window boundaries ====================================================
const full = { rangeStart: 0, rangeEnd: 0 };
check("full capture starts at 0", capStart(full) === 0);
check("full capture stops at duration", capStop(full, 600) === 600);

const mid = { rangeStart: 90, rangeEnd: 240 };
check("range capture rewinds by the lead-in", capStart(mid) === 84, capStart(mid));
check("range capture stops at the window end", capStop(mid, 600) === 240);

const early = { rangeStart: 2, rangeEnd: 30 };
check("lead-in never goes negative", capStart(early) === 0, capStart(early));

const past = { rangeStart: 500, rangeEnd: 9999 };
check("window end clamps to the real duration", capStop(past, 600) === 600, capStop(past, 600));

// === coverage measured from the window start ==============================
// Coverage that exists only BEFORE the window must not count as progress.
const beforeOnly = mergeCovered([[0, 60]]);
check("coverage before the window counts as none", coveredEndOf(beforeOnly, 84) === 84, coveredEndOf(beforeOnly, 84));

// Contiguous fill across the window advances the frontier.
const filling = mergeCovered([
  [0, 60],
  [84, 150],
]);
check("contiguous window coverage advances", coveredEndOf(filling, 84) === 150, coveredEndOf(filling, 84));

// A hole inside the window stops the frontier at the hole.
const holed = mergeCovered([
  [84, 120],
  [140, 240],
]);
check("a gap inside the window stops the frontier", coveredEndOf(holed, 84) === 120, coveredEndOf(holed, 84));

// Once the hole is filled, the frontier jumps past it to the window end.
const healed = mergeCovered([
  [84, 120],
  [118, 145],
  [140, 240],
]);
check("filling the gap advances to the window end", coveredEndOf(healed, 84) === 240, coveredEndOf(healed, 84));

// === completion + progress ================================================
function pct(cEnd, from, stopAt) {
  const span = Math.max(0.1, stopAt - from);
  return Math.min(99, Math.round(((cEnd - from) / span) * 100));
}
check("progress is 0% at the window start", pct(84, 84, 240) === 0);
check("progress is ~50% mid-window", pct(162, 84, 240) === 50, pct(162, 84, 240));
check("progress caps at 99 before finalize", pct(240, 84, 240) === 99, pct(240, 84, 240));

const done = (cEnd, stopAt) => cEnd >= stopAt - 1;
check("done when coverage reaches the window end", done(239.5, 240));
check("not done while short of the window end", !done(200, 240));

// Incomplete detection is measured across the window, not the whole video.
function incomplete(capEnd, capDur, from) {
  const span = capDur - from;
  const got = capEnd - from;
  return span > 5 && got > 0 && got < span - 3 && got < span * 0.95;
}
check("a fully-captured window is not flagged incomplete", !incomplete(240, 240, 84));
check("a stalled window IS flagged incomplete", incomplete(150, 240, 84));
check(
  "a full-video capture ending at duration is not incomplete",
  !incomplete(600, 600, 0)
);

// === popup time parsing ===================================================
check("parseTime m:ss", parseTime("1:30") === 90, parseTime("1:30"));
check("parseTime h:mm:ss", parseTime("1:02:03") === 3723, parseTime("1:02:03"));
check("parseTime bare seconds", parseTime("45") === 45);
check("parseTime garbage → 0", parseTime("abc") === 0);
check("fmtClock under an hour", fmtClock(90) === "1:30", fmtClock(90));
check("fmtClock over an hour", fmtClock(3723) === "1:02:03", fmtClock(3723));
check("fmtClock round-trips parseTime", parseTime(fmtClock(3723)) === 3723);

// === validation the popup enforces before starting ========================
const valid = (s, e) => e > s;
check("rejects end <= start", !valid(120, 120) && !valid(120, 60));
check("accepts a proper window", valid(90, 240));

// === the trim/alignment plan (mirror of offscreen.js ytTrimPlan) ==========
// REGRESSION 1 (12s file): ffmpeg's input -ss is relative to the START OF THE
// FILE; passing the absolute range start seeked past the window.
// REGRESSION 2/3 (A/V skew both directions): ffmpeg normalizes EACH INPUT
// independently, so tracks that don't start together need per-input seeks
// aimed at the same content instant (a video keyframe).
// REGRESSION 4 (full capture that began mid-video): the same alignment now
// applies to FULL captures too — a capture starting at the playhead had
// video/audio starts ~5s apart and no correction at all.
function ytTrimPlan(vT, aStart, hasRange, rangeStart, rangeEnd) {
  const vStart = vT.start;
  let vSeek = 0;
  let aSeek = null;
  let clipDur = 0;
  if (vStart < 0) {
    if (hasRange) clipDur = rangeEnd - rangeStart + 8;
    return { vSeek, aSeek, clipDur };
  }
  let target = null;
  if (hasRange && rangeStart >= vStart - 1 && rangeStart - vStart < 7200) {
    target = Math.max(rangeStart, vStart);
  } else if (!hasRange && aStart >= 0 && Math.abs(aStart - vStart) >= 0.3 && Math.abs(aStart - vStart) < 90) {
    target = Math.max(vStart, aStart);
  }
  if (target == null) {
    if (hasRange) clipDur = rangeEnd - rangeStart + 8;
    return { vSeek, aSeek, clipDur };
  }
  let kf = -1;
  for (const s of vT.frags) if (s <= target + 0.25 && s > kf) kf = s;
  if (kf < 0) kf = vStart;
  vSeek = Math.max(0, kf - vStart) + 0.1;
  if (aStart >= 0 && Math.abs(kf - aStart) < 120) aSeek = Math.max(0, kf - aStart) + 0.1;
  clipDur = hasRange ? Math.max(1, rangeEnd - kf) : 0;
  return { vSeek, aSeek, clipDur };
}
// The content time each cut lands at (what ffmpeg does per input).
const landsV = (p, vStart) => vStart + p.vSeek;
const landsA = (p, aStart) => aStart + (p.aSeek == null ? p.vSeek : p.aSeek);

const frags = (s, e, step) => {
  const out = [];
  for (let t = s; t <= e; t += step) out.push(t);
  return out;
};

// RANGE: 5:51→7:55 (351→475), video from 5:45 (345, frags every 2s), audio from 5:40 (340).
const vT1 = { start: 345, frags: frags(345, 475, 2) };
const r1 = ytTrimPlan(vT1, 340, true, 351, 475);
check("range: video cut at the keyframe ≤ start (351)", Math.abs(landsV(r1, 345) - 351.1) < 1e-9, landsV(r1, 345));
check("range: audio lands at the same instant", Math.abs(landsV(r1, 345) - landsA(r1, 340)) < 1e-9, landsA(r1, 340));
check("range: duration from the keyframe to rangeEnd", r1.clipDur === 475 - 351, r1.clipDur);

// FULL capture that began mid-video (the reported bug): video from 508 (8:28),
// audio buffered from 502 — 6s apart, no range requested.
const vT2 = { start: 508, frags: frags(508, 3223, 2) };
const r2 = ytTrimPlan(vT2, 502, false, 0, 0);
check("full/mid-video: alignment IS applied (audio no longer 6s early)", r2.aSeek != null, r2.aSeek);
check("full/mid-video: both tracks land together", Math.abs(landsV(r2, 508) - landsA(r2, 502)) < 1e-9, landsV(r2, 508) + " vs " + landsA(r2, 502));
check("full/mid-video: no duration clamp", r2.clipDur === 0);

// FULL capture from 0 with aligned tracks → untouched (no seeks at all).
const vT3 = { start: 0, frags: frags(0, 3223, 2) };
const r3 = ytTrimPlan(vT3, 0.05, false, 0, 0);
check("full/aligned: no seeks", r3.vSeek === 0 && r3.aSeek === null);
check("full/aligned: no duration clamp", r3.clipDur === 0);

// FULL capture, audio starts LATER than video → cut video forward to audio.
const r4 = ytTrimPlan(vT3, 6.2, false, 0, 0);
check("full/audio-late: video moves up to the keyframe ≤ audio start", Math.abs(landsV(r4, 0) - 6.1) < 1e-9, landsV(r4, 0));
check("full/audio-late: audio clamps to its own start", Math.abs(landsA(r4, 6.2) - 6.3) < 1e-9, landsA(r4, 6.2));

// Unknown audio start (WebM) → no audio seek, video untouched on full captures.
const r5 = ytTrimPlan(vT3, -1, false, 0, 0);
check("full/unknown-audio: nothing applied", r5.vSeek === 0 && r5.aSeek === null);

// Unknown VIDEO timing → range falls back to end-clamp only.
const r6 = ytTrimPlan({ start: -1, frags: [] }, -1, true, 1260, 1493);
check("range/unknown-video: no seek, padded end clamp", r6.vSeek === 0 && r6.clipDur === 1493 - 1260 + 8);

// Range start far outside the capture is rejected (no absolute-time seek).
const r7 = ytTrimPlan({ start: 345, frags: frags(345, 475, 2) }, 340, true, 20000, 20100);
check("range/implausible start: falls back to end clamp", r7.vSeek === 0 && r7.clipDur === 108, r7.clipDur);

// Full capture with tracks < 0.3s apart → treated as aligned.
const r8 = ytTrimPlan(vT3, 0.2, false, 0, 0);
check("sub-0.3s skew is left alone", r8.vSeek === 0 && r8.aSeek === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
