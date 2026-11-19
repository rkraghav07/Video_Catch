// Video Catch — offscreen worker
// - Fetches HLS playlists, downloads + decrypts segments, assembles the video
//   (and a separate audio track if the stream has one).
// - Uses ffmpeg.wasm to produce a clean .mp4 (stream-copy remux), mux separate
//   audio+video tracks, and to extract MP3 / trim clips / export GIFs.
// - Hands the finished Blob URL back to the background, which saves it via
//   chrome.downloads.download (so "Save as…" works and completion is reliable).
// - Supports cooperative pause / resume / cancel during the fetch phase.

const DEFAULT_CONCURRENCY = 10;
const CHUNK = 4 * 1024 * 1024;

// GLOBAL cap on simultaneous segment fetches across ALL downloads in this offscreen
// doc. Without it, N downloads × their per-job concurrency can open dozens of
// connections at once → Chrome dies with net::ERR_INSUFFICIENT_RESOURCES (e.g. 5
// videos at 16 each = 80 sockets). Every fetch waits for a slot here, so the total
// stays sane no matter how many downloads run. 30 lets a single Turbo download run
// full-tilt while still capping ALL downloads combined at 30 sockets (well under the
// ~80 that crashed Chrome): one download uses up to 30 slots; five share the same 30.
const MAX_GLOBAL_FETCHES = 30;
let activeFetches = 0;
const activeById = new Map(); // id -> active slots it currently holds (for the throttle)
const fetchWaiters = []; // { id, wake }
// SOFT priority: the one download the user flagged as "do this first". While it's set,
// EVERY other download combined is throttled to NONPRIORITY_SHARE slots — they keep
// running (not paused), just slowly — which frees both connections AND bandwidth for
// the prioritized one, so it visibly races ahead. It also jumps the convert queue.
// null = no priority; then it's a plain fair pool. Handoff also prefers the priority.
let priorityId = null;
const NONPRIORITY_SHARE = 6;

function slotAvailableFor(id) {
  if (activeFetches >= MAX_GLOBAL_FETCHES) return false;
  if (priorityId != null && id !== priorityId) {
    // Only clamp the others when the priority download is actually hungry (has a
    // waiter) — otherwise let them use idle slots so we don't waste the pool.
    const priWaiting = fetchWaiters.some((w) => w.id === priorityId);
    const nonPri = activeFetches - (activeById.get(priorityId) || 0);
    if (priWaiting && nonPri >= NONPRIORITY_SHARE) return false;
  }
  return true;
}
function takeSlot(id) {
  activeFetches++;
  activeById.set(id, (activeById.get(id) || 0) + 1);
}
function acquireFetchSlot(id) {
  if (slotAvailableFor(id)) {
    takeSlot(id);
    return Promise.resolve();
  }
  return new Promise((wake) => fetchWaiters.push({ id, wake }));
}
function releaseFetchSlot(id) {
  activeFetches = Math.max(0, activeFetches - 1);
  const n = (activeById.get(id) || 0) - 1;
  if (n > 0) activeById.set(id, n);
  else activeById.delete(id);
  pumpWaiters();
}
// Wake as many waiters as capacity now allows, always serving the prioritized
// download's waiters first. Called on every release and whenever priority changes.
function pumpWaiters() {
  while (fetchWaiters.length) {
    let idx = -1;
    if (priorityId != null) idx = fetchWaiters.findIndex((w) => w.id === priorityId && slotAvailableFor(w.id));
    if (idx < 0) idx = fetchWaiters.findIndex((w) => slotAvailableFor(w.id));
    if (idx < 0) break;
    const w = fetchWaiters.splice(idx, 1)[0];
    takeSlot(w.id);
    w.wake();
  }
}
// Hard cap on bytes we'll hold in memory to run ffmpeg on (clip/gif/mp3 of a
// progressive file). Larger files would risk crashing the tab.
const FFMPEG_MAX_BYTES = 1200 * 1024 * 1024;
// Above this we don't even attempt an ffmpeg convert/remux: ffmpeg.wasm must hold
// the whole file in one ArrayBuffer, which the engine caps at ~2GB. Keep a margin.
const CONVERT_MAX_BYTES = 1900 * 1024 * 1024;
// If a segment/playlist fetch goes silent (no bytes received) for this long, treat
// it as stalled, abort, and auto-retry. Idle-based, so a slow-but-progressing
// download is never interrupted — only a truly dead connection.
const SEGMENT_IDLE_MS = 30000;
const FETCH_MAX_TRIES = 4;

// --- cooperative job control (pause / resume / cancel) ----------------------

const controls = new Map(); // id -> { paused, canceled, waiters: [] }

function getControl(id) {
  let c = controls.get(id);
  if (!c) {
    c = { paused: false, canceled: false, converting: false, abort: new AbortController(), waiters: [] };
    controls.set(id, c);
  }
  return c;
}

function signalFor(id) {
  return getControl(id).abort.signal;
}

// Reset a job's control at the START of a (re)run — clears a stale canceled flag
// from a prior failed attempt and hands it a fresh AbortController, so a retry
// starts clean and any lingering workers from the old attempt are aborted (they see
// the aborted old signal and stop) instead of posting progress alongside the retry.
function beginRun(id) {
  const c = getControl(id);
  try {
    c.abort.abort();
  } catch {}
  c.canceled = false;
  c.paused = false;
  c.converting = false;
  c.abort = new AbortController();
  c.waiters.splice(0).forEach((r) => r());
}

function setPaused(id, paused) {
  const c = getControl(id);
  c.paused = paused;
  if (paused) {
    // Abort in-flight fetches NOW so the network actually stops, then hand the
    // job a fresh controller so it can resume cleanly. Aborted requests are
    // retried (same segment/range) once resumed — see pausableFetch.
    try {
      c.abort.abort();
    } catch {}
    c.abort = new AbortController();
  } else {
    c.waiters.splice(0).forEach((r) => r());
  }
}

// Run a fetch with pause/cancel awareness: blocks while paused, and if its
// in-flight attempt was aborted by a pause, retries the SAME request after
// resume. Throws CanceledError on cancel.
async function pausableFetch(id, doFetch) {
  while (true) {
    await checkpoint(id); // blocks while paused; throws if canceled
    try {
      return await doFetch(getControl(id).abort.signal);
    } catch (e) {
      const c = getControl(id);
      if (c.canceled) throw new CanceledError();
      if (c.paused || (e && e.name === "AbortError")) continue; // paused mid-flight → retry
      throw e;
    }
  }
}

// Hard-cancel: flip the flag (stops the work loop), abort every in-flight fetch
// immediately, wake any paused waiter, and — if we're mid-ffmpeg — terminate the
// wasm worker (exec can't be interrupted any other way) and force a reload next
// time. This actually stops the download instead of just hiding the row.
async function cancelJob(id) {
  const c = getControl(id);
  c.canceled = true;
  c.paused = false;
  try {
    c.abort.abort();
  } catch {}
  c.waiters.splice(0).forEach((r) => r());
  // If it's only WAITING for the convert lock, drop it from the queue and wake it
  // so it throws CanceledError immediately (never occupies the lock).
  if (c.convertWaiter) {
    const i = convertWaiters.indexOf(c.convertWaiter);
    if (i >= 0) convertWaiters.splice(i, 1);
    const wake = c.convertWaiter;
    c.convertWaiter = null;
    wake();
  }
  if (c.converting && ffmpegPromise) {
    try {
      const ff = await ffmpegPromise;
      ff.terminate();
    } catch {}
    ffmpegPromise = null;
  }
}

class CanceledError extends Error {
  constructor() {
    super("canceled");
    this.canceled = true;
  }
}

// Call at the top of each unit of work. Blocks while paused; throws if canceled.
async function checkpoint(id) {
  const c = getControl(id);
  if (c.canceled) throw new CanceledError();
  if (c.paused) {
    await new Promise((res) => c.waiters.push(res));
    if (c.canceled) throw new CanceledError();
  }
}

// --- convert lock (serialize the CPU-heavy convert/remux/mux stage) ----------
// mux.js runs SYNCHRONOUSLY on this single offscreen thread and ffmpeg.wasm is a
// single instance — so N multi-GB converts in flight just thrash one thread and
// all crawl to the finish together (and hold every partial output in memory).
// Serialize them: only ONE converts at a time, so the first finishes FAST and
// saves while the rest wait as "queued" and complete progressively. Fetching
// stays parallel (bounded separately by the global fetch semaphore).
let convertBusy = false;
const convertWaiters = [];
let activeConvertId = null; // job holding the lock (lets the ffmpeg progress hook know whose % to report)

async function withConvertLock(id, fn) {
  const c = getControl(id);
  if (convertBusy) {
    chrome.runtime.sendMessage({ type: "hls-phase", id, phase: "queued" });
    await new Promise((res) => {
      c.convertWaiter = res;
      // Prioritized job jumps to the FRONT of the convert queue.
      if (priorityId === id) convertWaiters.unshift(res);
      else convertWaiters.push(res);
    });
    c.convertWaiter = null;
    if (c.canceled) throw new CanceledError(); // canceled while queued — bail before doing any work
  }
  convertBusy = true;
  activeConvertId = id;
  c.converting = true;
  chrome.runtime.sendMessage({ type: "hls-phase", id, phase: "converting" });
  try {
    return await fn();
  } finally {
    activeConvertId = null;
    convertBusy = false;
    const next = convertWaiters.shift();
    if (next) next();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "list-jobs") {
    // The background (freshly restarted) asks which jobs are still alive here, so
    // it doesn't mark a running/paused job "failed" and later discard its blob.
    sendResponse({ ids: [...controls.keys()] });
    return;
  }
  if (msg.type === "hls-download") {
    beginRun(msg.id);
    runHls(msg)
      .catch((err) => reportFailure(msg.id, err))
      .finally(() => controls.delete(msg.id));
  } else if (msg.type === "dash-download") {
    beginRun(msg.id);
    runDash(msg)
      .catch((err) => reportFailure(msg.id, err))
      .finally(() => controls.delete(msg.id));
  } else if (msg.type === "reddit-av") {
    beginRun(msg.id);
    runRedditAV(msg)
      .catch((err) => reportFailure(msg.id, err))
      .finally(() => controls.delete(msg.id));
  } else if (msg.type === "file-download") {
    beginRun(msg.id);
    runFile(msg)
      .catch((err) => {
        // Plain video with no range support → let the browser download it.
        if ((msg.mode || "video") === "video" && /no range|too large|unknown size/i.test(String(err.message || err))) {
          chrome.runtime.sendMessage({ type: "file-fallback", id: msg.id, url: msg.url, filename: msg.filename });
        } else {
          reportFailure(msg.id, err);
        }
      })
      .finally(() => controls.delete(msg.id));
  } else if (msg.type === "job-pause") {
    setPaused(msg.id, true);
  } else if (msg.type === "job-resume") {
    setPaused(msg.id, false);
  } else if (msg.type === "job-cancel") {
    cancelJob(msg.id);
  } else if (msg.type === "yt-cap-init") {
    // A track's codec-config (init segment), streamed live from the page.
    capTrack(msg.captureId, msg.trackId, msg.kind, msg.mime).init = b64ToBytes(msg.b64);
  } else if (msg.type === "yt-cap-data") {
    // One captured media fragment, streamed live — decoded once and appended to
    // the track's rolling Blob store with its decode time.
    capAppend(capTrack(msg.captureId, msg.trackId, msg.kind, msg.mime), b64ToBytes(msg.b64), msg.t);
  } else if (msg.type === "yt-cap-wipe") {
    // The page restarted its stream (reload-from-0) — drop what was shipped.
    captures.delete(msg.captureId);
  } else if (msg.type === "set-priority") {
    priorityId = msg.id != null ? msg.id : null; // soft priority target (or null to clear)
    pumpWaiters(); // clearing/loosening the throttle may free slots for waiting fetches
  } else if (msg.type === "yt-cap-cancel") {
    captures.delete(msg.captureId); // user canceled — free the captured bytes
  } else if (msg.type === "yt-cap-done") {
    runYtMux(msg.captureId, msg.id, msg.filename, msg.duration, msg.rangeStart || 0, msg.rangeEnd || 0).catch((err) =>
      reportFailure(msg.id, err)
    );
  } else if (msg.type === "save-anchor") {
    anchorSave(msg.objUrl, msg.filename);
  } else if (msg.type === "hls-revoke") {
    try {
      URL.revokeObjectURL(msg.objUrl);
    } catch {}
  }
});

function reportFailure(id, err) {
  const c = controls.get(id);
  const canceled = (err && (err.canceled || err.name === "AbortError")) || (c && c.canceled);
  if (canceled) {
    chrome.runtime.sendMessage({ type: "job-canceled", id });
  } else {
    // Log the full stack so the offscreen console pinpoints WHERE it failed
    // (segment fetch vs. assembleMedia's blob.arrayBuffer() vs. ffmpeg convert).
    console.error("[VideoCatch][offscreen] job failed:", (err && (err.stack || err.message)) || err);
    chrome.runtime.sendMessage({ type: "hls-error", id, error: String((err && err.message) || err) });
  }
}

// --- hand a finished Blob back to the background to save --------------------

function saveBlob(id, blob, filename) {
  const objUrl = URL.createObjectURL(blob);
  // The background saves via chrome.downloads.download (gives a real Save-as
  // dialog + reliable completion). We keep the blob alive until it's revoked.
  chrome.runtime.sendMessage({ type: "hls-ready", id, objUrl, filename, bytes: blob.size });
  // Safety net: revoke after 15 min even if no revoke message arrives.
  setTimeout(() => {
    try {
      URL.revokeObjectURL(objUrl);
    } catch {}
  }, 15 * 60 * 1000);
}

// Fallback save path if chrome.downloads.download can't fetch the blob URL.
function anchorSave(objUrl, filename) {
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function ensureExt(filename, ext) {
  return /\.[a-z0-9]{2,4}$/i.test(filename) ? filename.replace(/\.[^.]+$/, ext) : filename + ext;
}

// Sniff a fragmented stream's container from its magic bytes. YouTube serves
// video and audio in DIFFERENT containers (commonly mp4/AV1 or mp4/H264 video +
// webm/Opus audio), and for many videos BOTH tracks are webm (VP9 + Opus). We
// must demux/mux each with the right container, not assume mp4.
function sniffContainer(bytes) {
  if (!bytes || bytes.byteLength < 8) return "mp4";
  // WebM/Matroska: EBML header 1A 45 DF A3
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  // ISO-BMFF: 'ftyp'/'styp'/'moov'/'moof' as the first box type (bytes 4..7)
  const t = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (t === "ftyp" || t === "styp" || t === "moov" || t === "moof") return "mp4";
  return "mp4";
}

function postProgress(id, done, total, phase) {
  chrome.runtime.sendMessage({ type: "hls-progress", id, done, total, phase });
}

// --- ffmpeg.wasm (loaded on demand) ----------------------------------------

let ffmpegPromise = null;

function loadFFmpegScript() {
  return new Promise((resolve, reject) => {
    if (self.FFmpegWASM) return resolve();
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("vendor/ffmpeg/ffmpeg.js");
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("failed to load ffmpeg.js"));
    document.head.appendChild(s);
  });
}

function getFFmpeg() {
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = (async () => {
    await loadFFmpegScript();
    const { FFmpeg } = self.FFmpegWASM;
    const ff = new FFmpeg();
    // IMPORTANT: do NOT pass `classWorkerURL`. When set, @ffmpeg/ffmpeg spawns the
    // worker as a MODULE worker (`{type:"module"}`), which has no `importScripts`;
    // it then falls back to `import(coreURL)` which fails on our UMD core ("failed
    // to import ffmpeg-core.js"). Omitting it uses the CLASSIC worker path, which
    // resolves the worker chunk (814.ffmpeg.js) from this script's own URL — valid
    // because we load ffmpeg.js via a <script> tag (document.currentScript is set)
    // — and uses `importScripts(coreURL)` to load the UMD core. Same-origin
    // extension URLs are allowed under the page CSP ('self').
    await ff.load({
      coreURL: chrome.runtime.getURL("vendor/ffmpeg/ffmpeg-core.js"),
      wasmURL: chrome.runtime.getURL("vendor/ffmpeg/ffmpeg-core.wasm"),
    });
    // Surface conversion progress on the "Processing… N%" bar. Safe to key off a
    // single module var because converts are serialized (withConvertLock) — only
    // one ffmpeg exec runs at a time, so activeConvertId always names its owner.
    ff.on("progress", (e) => {
      if (activeConvertId != null && e && typeof e.progress === "number") {
        postProgress(activeConvertId, Math.max(0, Math.min(100, Math.round(e.progress * 100))), 100);
      }
    });
    return ff;
  })().catch((e) => {
    ffmpegPromise = null;
    throw e;
  });
  return ffmpegPromise;
}

// --- streaming MPEG-TS -> MP4 remux (mux.js) -------------------------------
// ffmpeg needs the whole file in one ~2GB-capped ArrayBuffer, so it can't convert
// multi-GB streams. mux.js remuxes MPEG-TS to fragmented MP4 incrementally, so we
// feed the (possibly multi-GB) .ts Blob in small slices and collect the MP4 output
// into Blobs — never holding the whole file in memory at once.
let muxjsLoad = null;
function loadMuxjs() {
  if (muxjsLoad) return muxjsLoad;
  muxjsLoad = new Promise((resolve, reject) => {
    if (self.muxjs) return resolve(self.muxjs);
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("vendor/mux/mux.js");
    s.onload = () => (self.muxjs ? resolve(self.muxjs) : reject(new Error("mux.js loaded but no global")));
    s.onerror = () => reject(new Error("failed to load mux.js"));
    document.head.appendChild(s);
  }).catch((e) => {
    muxjsLoad = null;
    throw e;
  });
  return muxjsLoad;
}

// Overwrite the duration fields in an MP4 init segment (mvhd / mehd / tkhd / mdhd)
// so a stream whose remux computed a bogus length (a 47-min TS reporting 13h from a
// PTS discontinuity) shows/plays the correct duration. No re-encode → works at any
// size. Defensive: validates every box + bounds, so a bad offset patches nothing
// rather than corrupting the file.
function patchMoovDurations(init, realDurSec) {
  try {
    if (!realDurSec || realDurSec <= 0) return init;
    const dv = new DataView(init.buffer, init.byteOffset, init.byteLength);
    const type = (o) => String.fromCharCode(init[o + 4], init[o + 5], init[o + 6], init[o + 7]);
    const setU32 = (o, v) => dv.setUint32(o, v >>> 0);
    const setU64 = (o, v) => {
      dv.setUint32(o, Math.floor(v / 4294967296));
      dv.setUint32(o + 4, v >>> 0);
    };
    const walk = (start, end, cb) => {
      let o = start;
      while (o + 8 <= end) {
        let size = dv.getUint32(o);
        if (size === 1) {
          if (o + 16 > end) break;
          size = dv.getUint32(o + 8) * 4294967296 + dv.getUint32(o + 12);
        } else if (size === 0) size = end - o;
        if (size < 8 || o + size > end) break;
        cb(o, size, type(o));
        o += size;
      }
    };
    let movieTs = 0;
    walk(0, init.byteLength, (mo, msize, mt) => {
      if (mt !== "moov") return;
      walk(mo + 8, mo + msize, (o, size, t) => {
        const ver = init[o + 8];
        if (t === "mvhd") {
          if (ver === 1) { movieTs = dv.getUint32(o + 28); setU64(o + 32, realDurSec * movieTs); }
          else { movieTs = dv.getUint32(o + 20); setU32(o + 24, Math.round(realDurSec * movieTs)); }
        } else if (t === "mvex") {
          walk(o + 8, o + size, (o2, s2, t2) => {
            if (t2 !== "mehd") return;
            if (init[o2 + 8] === 1) setU64(o2 + 12, realDurSec * movieTs);
            else setU32(o2 + 12, Math.round(realDurSec * movieTs));
          });
        } else if (t === "trak") {
          walk(o + 8, o + size, (o2, s2, t2) => {
            if (t2 === "tkhd") {
              if (init[o2 + 8] === 1) setU64(o2 + 36, realDurSec * movieTs);
              else setU32(o2 + 28, Math.round(realDurSec * movieTs));
            } else if (t2 === "mdia") {
              walk(o2 + 8, o2 + s2, (o3, s3, t3) => {
                if (t3 !== "mdhd") return;
                if (init[o3 + 8] === 1) { const ts = dv.getUint32(o3 + 28); setU64(o3 + 32, realDurSec * ts); }
                else { const ts = dv.getUint32(o3 + 20); setU32(o3 + 24, Math.round(realDurSec * ts)); }
              });
            }
          });
        }
      });
    });
  } catch {}
  return init;
}

async function remuxTsBlobToMp4(tsBlob, segSizes, id, realDurSec = 0) {
  const muxjs = await loadMuxjs();

  // Consolidate output into Blobs every ~64MB so the JS heap stays bounded even
  // for a multi-GB result (a Blob can spill to disk; a JS array of it cannot).
  const blobParts = [];
  let pending = [];
  let pendingBytes = 0;
  const FLUSH_AT = 64 * 1024 * 1024;
  const flushPending = () => {
    if (pending.length) {
      blobParts.push(new Blob(pending));
      pending = [];
      pendingBytes = 0;
    }
  };

  let gotInit = false;
  // keepOriginalTimestamps:false NORMALIZES the timeline to start at 0. With `true`
  // mux.js keeps the stream's raw PTS, which on some streams starts at a large
  // offset → a bogus duration (e.g. a 47-min video reporting 13h). Verified against
  // a real HLS stream: false → exact playlist duration, audio+video in sync; true →
  // inflated. (Do NOT use setBaseMediaDecodeTime here — it truncates the duration.)
  const tm = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false });
  tm.on("data", (seg) => {
    // The init segment (ftyp+moov) is emitted with every 'data' event; keep the
    // first one (it must lead the file), drop the rest.
    if (!gotInit && seg.initSegment && seg.initSegment.byteLength) {
      // Stamp the real duration into the moov so a discontinuity-inflated stream
      // ("13-hour" file) shows/plays the correct length.
      const initBytes = patchMoovDurations(new Uint8Array(seg.initSegment), realDurSec);
      pending.push(initBytes);
      pendingBytes += initBytes.byteLength;
      gotInit = true;
    }
    if (seg.data && seg.data.byteLength) {
      pending.push(new Uint8Array(seg.data));
      pendingBytes += seg.data.byteLength;
      if (pendingBytes >= FLUSH_AT) flushPending();
    }
  });

  const total = tsBlob.size;
  const pushSlice = async (start, end) => {
    const chunk = new Uint8Array(await tsBlob.slice(start, end).arrayBuffer());
    tm.push(chunk); // mux.js buffers to 188-byte TS packet boundaries internally
    postProgress(id, end, total);
  };

  // Flush mux.js on SEGMENT boundaries. HLS segments start on a keyframe, so each
  // flush emits a complete GOP and mux.js computes fragment durations correctly.
  // (Flushing at arbitrary byte offsets cuts mid-frame → wrong sample durations →
  // a bogus total duration, e.g. a 47-min video reporting 13h.) Per-segment flush
  // ALSO keeps each allocation tiny, avoiding the ~2GB single-buffer cap on flush.
  const boundaries = Array.isArray(segSizes) && segSizes.length ? segSizes : null;
  if (boundaries) {
    let off = 0;
    for (let i = 0; i < boundaries.length; i++) {
      await checkpoint(id); // honour pause/cancel
      const end = off + boundaries[i];
      if (end > off) {
        await pushSlice(off, end);
        tm.flush(); // segment complete (keyframe-aligned) → drain it
      }
      off = end;
    }
  } else {
    // Fallback (no segment map): fixed slices with periodic flush. Timestamps may
    // be slightly off at the cut points, but it won't hit the 2GB cap.
    const SLICE = 8 * 1024 * 1024;
    let off = 0;
    let sinceFlush = 0;
    while (off < total) {
      await checkpoint(id);
      const end = Math.min(off + SLICE, total);
      await pushSlice(off, end);
      sinceFlush += end - off;
      if (sinceFlush >= 48 * 1024 * 1024) {
        tm.flush();
        sinceFlush = 0;
      }
      off = end;
    }
  }
  tm.flush(); // final tail
  flushPending();

  if (!gotInit || !blobParts.length) throw new Error("TS remux produced no MP4 output");
  return new Blob(blobParts, { type: "video/mp4" });
}

async function ffRemux(bytes, inExt, outExt = "mp4", durationSec = 0, seekSec = 0) {
  const ff = await getFFmpeg();
  const inName = "in." + inExt;
  const outName = "out." + outExt;
  // Clamp to the real duration when known. MSE-captured fMP4 can carry a bogus
  // container duration (the "13-hour timeline that blacks out after the real
  // content" bug) — `-t` cuts the garbage tail and make_zero normalises timestamps.
  const dur = durationSec && isFinite(durationSec) && durationSec > 0 ? ["-t", String(Math.round(durationSec) + 1)] : [];
  const durIn = dur.length ? ["-avoid_negative_ts", "make_zero"] : [];
  // Input seek for range captures: MSE fragments carry ABSOLUTE decode times, so
  // `-ss` before -i lands on the requested spot (copy cuts at the keyframe ≤ start).
  const seek = seekSec && isFinite(seekSec) && seekSec > 0 ? ["-ss", String(seekSec)] : [];
  // NOTE: writeFile TRANSFERS (detaches) bytes.buffer to the worker. Callers that
  // may retry must pass FRESH bytes each attempt (see runYtMux).
  await ff.writeFile(inName, bytes);
  const copyArgs = [...seek, "-i", inName, "-c", "copy", ...durIn];
  if (outExt === "mp4") copyArgs.push("-movflags", "+faststart");
  copyArgs.push(...dur, outName);
  let out;
  try {
    await ff.exec(copyArgs);
    out = await ff.readFile(outName);
  } catch {
    out = null;
  }
  // Stream-copy fails on some .ts streams (codec/bitstream/timestamp quirks) —
  // the convert then "doesn't work" and the caller falls back to a raw .ts. Retry
  // by RE-ENCODING into the container so we still get a real .mp4. Slower, but only
  // runs for the streams that can't be copied. inName is still in MEMFS.
  if (!out || !out.length) {
    ff.deleteFile(outName).catch(() => {});
    const reArgs = [...seek, "-i", inName, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac"];
    if (outExt === "mp4") reArgs.push("-movflags", "+faststart");
    reArgs.push(...dur, outName);
    await ff.exec(reArgs);
    out = await ff.readFile(outName);
  }
  ff.deleteFile(inName).catch(() => {});
  ff.deleteFile(outName).catch(() => {});
  if (!out || !out.length) throw new Error("remux produced no output");
  return out;
}

async function ffMux(videoBytes, vExt, audioBytes, aExt, outExt = "mp4", durationSec = 0, seekSecV = 0, seekSecA = null) {
  const ff = await getFFmpeg();
  const v = "v." + vExt;
  const a = "a." + aExt;
  const outName = "out." + outExt;
  // Clamp to the real duration when known (fixes MSE captures whose container
  // claims a bogus 13-hour length and black-out after the real content).
  const dur = durationSec && isFinite(durationSec) && durationSec > 0 ? ["-t", String(Math.round(durationSec) + 1)] : [];
  const durIn = dur.length ? ["-avoid_negative_ts", "make_zero"] : [];
  // PER-INPUT seeks. ffmpeg normalizes every input independently (its timestamps
  // are offset by its own seek target / start time), so the video and audio need
  // seeks computed from EACH track's own start to cut at the same content
  // instant. A shared seek skews the tracks by the difference in their starts.
  const aVal = seekSecA == null ? seekSecV : seekSecA;
  const seekV = seekSecV && isFinite(seekSecV) && seekSecV > 0 ? ["-ss", String(seekSecV)] : [];
  const seekA = aVal && isFinite(aVal) && aVal > 0 ? ["-ss", String(aVal)] : [];
  // NOTE: writeFile TRANSFERS (detaches) each buffer to the worker. Callers that
  // may retry must pass FRESH bytes each attempt (see runYtMux).
  await ff.writeFile(v, videoBytes);
  await ff.writeFile(a, audioBytes);
  const copyArgs = [...seekV, "-i", v, ...seekA, "-i", a, "-c", "copy", ...durIn];
  if (outExt === "mp4") copyArgs.push("-movflags", "+faststart");
  copyArgs.push("-map", "0:v:0", "-map", "1:a:0", ...dur, outName);
  let out;
  try {
    await ff.exec(copyArgs);
    out = await ff.readFile(outName);
  } catch {
    out = null;
  }
  // Copy-mux fails when the tracks' codecs/bitstreams don't drop into the container
  // cleanly — re-encode as a fallback so we still produce a playable file.
  if (!out || !out.length) {
    ff.deleteFile(outName).catch(() => {});
    const reArgs = [...seekV, "-i", v, ...seekA, "-i", a, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac"];
    if (outExt === "mp4") reArgs.push("-movflags", "+faststart");
    reArgs.push("-map", "0:v:0", "-map", "1:a:0", ...dur, outName);
    await ff.exec(reArgs);
    out = await ff.readFile(outName);
  }
  ff.deleteFile(v).catch(() => {});
  ff.deleteFile(a).catch(() => {});
  ff.deleteFile(outName).catch(() => {});
  if (!out || !out.length) throw new Error("mux produced no output");
  return out;
}

// --- Blob-mounted mux (WORKERFS) — the big-capture path ----------------------
// ffmpeg.wasm's MEMFS lives inside its ~2GB wasm heap, so writeFile-based muxing
// needs inputs + output to fit together (~2× the capture). WORKERFS instead
// mounts Blobs read LAZILY from disk — only the OUTPUT occupies the heap. That
// lifts the in-browser merge ceiling to ~1.8GB of captured tracks, covering the
// whole 1.5GB capture cap: big captures merge automatically, no manual ffmpeg.
// Copy-only (no re-encode retry here — a >1GB re-encode in wasm isn't practical);
// the caller falls back to mkv and then to a split save if this fails.
let mountSeq = 0;
async function ffMuxMounted(vBlob, aBlob, outExt, durationSec = 0, seekSecV = 0, seekSecA = null) {
  const ff = await getFFmpeg();
  // Unique mount point per attempt — if a failed exec leaves a mount stuck,
  // the retry must not trip over it ("mount point in use" would cascade every
  // attempt into failure and degrade the capture to the split save).
  const MOUNT = "/capture" + mountSeq++;
  const outName = "out." + outExt;
  const dur = durationSec && isFinite(durationSec) && durationSec > 0 ? ["-t", String(Math.round(durationSec) + 1)] : [];
  // Per-input seeks — see ffMux: each input is normalized independently, so the
  // audio seek must come from the AUDIO track's own start time.
  const aVal = seekSecA == null ? seekSecV : seekSecA;
  const seekV = seekSecV && isFinite(seekSecV) && seekSecV > 0 ? ["-ss", String(seekSecV)] : [];
  const seekA = aVal && isFinite(aVal) && aVal > 0 ? ["-ss", String(aVal)] : [];
  // Seeking can leave a slightly negative first timestamp (the keyframe sits just
  // before the seek target) — shift the whole file uniformly whenever we trim.
  const durIn = dur.length || seekV.length || seekA.length ? ["-avoid_negative_ts", "make_zero"] : [];
  const blobs = [{ name: "v", data: vBlob }];
  if (aBlob) blobs.push({ name: "a", data: aBlob });
  await ff.createDir(MOUNT).catch(() => {});
  await ff.mount("WORKERFS", { blobs }, MOUNT);
  try {
    const args = [...seekV, "-i", `${MOUNT}/v`];
    if (aBlob) args.push(...seekA, "-i", `${MOUNT}/a`);
    args.push("-c", "copy", ...durIn);
    if (outExt === "mp4") args.push("-movflags", "+faststart");
    if (aBlob) args.push("-map", "0:v:0", "-map", "1:a:0");
    args.push(...dur, outName);
    await ff.exec(args);
    const out = await ff.readFile(outName);
    if (!out || !out.length) throw new Error("mounted mux produced no output");
    return out;
  } finally {
    ff.deleteFile(outName).catch(() => {});
    try {
      await ff.unmount(MOUNT);
    } catch {}
    ff.deleteDir(MOUNT).catch(() => {});
  }
}

// Extract the audio track. Tries MP3 (libmp3lame); if the core lacks the
// encoder, falls back to copying the existing AAC into an .m4a (instant).
async function ffExtractAudio(srcBytes, srcExt) {
  const ff = await getFFmpeg();
  const inName = "in." + srcExt;
  await ff.writeFile(inName, srcBytes);

  // Try in order: a real MP3 (only if the core actually has libmp3lame), then copy
  // the existing audio into .m4a (instant when the source is AAC), then AAC
  // re-encode into .m4a (handles other source codecs). Each attempt is isolated so
  // a missing encoder / missing output doesn't crash with a raw "FS error" — we
  // just move to the next. If they ALL fail the video most likely has no audio.
  const attempts = [
    { args: ["-i", inName, "-vn", "-c:a", "libmp3lame", "-q:a", "2", "out.mp3"], out: "out.mp3", ext: ".mp3", type: "audio/mpeg" },
    { args: ["-i", inName, "-vn", "-c:a", "copy", "out.m4a"], out: "out.m4a", ext: ".m4a", type: "audio/mp4" },
    { args: ["-i", inName, "-vn", "-c:a", "aac", "-b:a", "192k", "out.m4a"], out: "out.m4a", ext: ".m4a", type: "audio/mp4" },
  ];
  for (const a of attempts) {
    try {
      await ff.exec(a.args);
      const out = await ff.readFile(a.out); // throws FS error if the exec made no file
      if (out && out.length) {
        ff.deleteFile(inName).catch(() => {});
        ff.deleteFile(a.out).catch(() => {});
        return { bytes: out, ext: a.ext, type: a.type };
      }
    } catch {}
    ff.deleteFile(a.out).catch(() => {}); // clear any partial before the next attempt
  }
  ff.deleteFile(inName).catch(() => {});
  throw new Error("Couldn't extract audio — this video may have no audio track.");
}

// Trim [start,end] seconds. Input seek (-ss) + duration (-t) is unambiguous and
// keeps stream-copy fast.
async function ffClip(srcBytes, srcExt, start, end) {
  const ff = await getFFmpeg();
  const inName = "in." + srcExt;
  await ff.writeFile(inName, srcBytes);
  const dur = end && end > start ? end - start : undefined;
  const args = ["-ss", String(start), "-i", inName];
  if (dur) args.push("-t", String(dur));
  args.push("-c", "copy", "-movflags", "+faststart", "out.mp4");
  await ff.exec(args);
  let out = await ff.readFile("out.mp4");
  // Some streams won't stream-copy cleanly from a mid-stream keyframe; re-encode
  // as a fallback so a clip is never empty.
  if (!out || !out.length) {
    const args2 = ["-ss", String(start), "-i", inName];
    if (dur) args2.push("-t", String(dur));
    args2.push("-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-movflags", "+faststart", "out.mp4");
    await ff.exec(args2);
    out = await ff.readFile("out.mp4");
  }
  ff.deleteFile(inName).catch(() => {});
  ff.deleteFile("out.mp4").catch(() => {});
  if (!out || !out.length) throw new Error("clip produced no output");
  return out;
}

// Make a GIF from [start, start+dur]. Uses a palette for clean colours.
async function ffGif(srcBytes, srcExt, start, dur) {
  const ff = await getFFmpeg();
  const inName = "in." + srcExt;
  await ff.writeFile(inName, srcBytes);
  const vf = "fps=12,scale=480:-1:flags=lanczos";
  await ff.exec([
    "-ss", String(start), "-t", String(dur), "-i", inName,
    "-vf", vf, "-loop", "0", "out.gif",
  ]);
  const out = await ff.readFile("out.gif");
  ff.deleteFile(inName).catch(() => {});
  ff.deleteFile("out.gif").catch(() => {});
  if (!out || !out.length) throw new Error("gif produced no output");
  return out;
}

// --- fetch helpers ---------------------------------------------------------

// Fetch a URL to bytes with an IDLE timeout. We stream the body and reset the
// clock on every chunk, so a slow-but-trickling response is never aborted — only
// one that goes truly silent for SEGMENT_IDLE_MS. Pause/cancel comes in via the
// job `signal`; we surface that as a real AbortError so the OUTER pausableFetch
// handles pause/resume/cancel, while an idle stall is flagged (.timeout) for the
// auto-retry layer below. This is the critical download path — keep it exact.
async function readBytesIdle(url, jobSignal, idleMs) {
  const ctrl = new AbortController();
  let idledOut = false;
  const onJobAbort = () => ctrl.abort();
  if (jobSignal) {
    if (jobSignal.aborted) ctrl.abort();
    else jobSignal.addEventListener("abort", onJobAbort, { once: true });
  }
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idledOut = true;
      ctrl.abort();
    }, idleMs);
  };
  try {
    armIdle(); // also covers a server that's slow to send headers
    const r = await fetch(url, { credentials: "include", signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!r.body || !r.body.getReader) {
      return new Uint8Array(await r.arrayBuffer()); // no stream available — fall back
    }
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle(); // data arrived → reset the idle clock
      if (value && value.byteLength) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  } catch (e) {
    // Pause/cancel aborted the JOB signal → surface AbortError for pausableFetch.
    if (jobSignal && jobSignal.aborted) {
      const ae = new Error("aborted");
      ae.name = "AbortError";
      throw ae;
    }
    // WE aborted it for going silent → flag as a retryable timeout.
    if (idledOut) {
      const te = new Error("stalled (no data received)");
      te.timeout = true;
      throw te;
    }
    throw e; // genuine network / HTTP error
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (jobSignal) jobSignal.removeEventListener("abort", onJobAbort);
  }
}

// Idle-timeout read + bounded auto-retry with backoff. A pause/cancel (AbortError)
// is re-thrown immediately so the outer pausableFetch handles it; a stall or
// network blip is retried up to FETCH_MAX_TRIES, after which the job fails cleanly.
async function fetchBytesRobust(url, signal, id) {
  for (let attempt = 1; ; attempt++) {
    let err;
    // Take a GLOBAL fetch slot so we never open more than MAX_GLOBAL_FETCHES sockets
    // across all downloads at once (the ERR_INSUFFICIENT_RESOURCES cause). Released
    // in finally — the backoff below happens WITHOUT holding a slot. `id` lets the
    // slot handoff favour the prioritized download.
    await acquireFetchSlot(id);
    try {
      return await readBytesIdle(url, signal, SEGMENT_IDLE_MS);
    } catch (e) {
      err = e;
    } finally {
      releaseFetchSlot(id);
    }
    if (err && err.name === "AbortError") throw err; // pause/cancel — defer to pausableFetch
    if (attempt >= FETCH_MAX_TRIES) {
      throw new Error(`fetch failed after ${attempt} tries: ${(err && err.message) || err}`);
    }
    // Chrome ran out of sockets/memory (too many downloads at once) — back off HARD
    // so in-flight fetches drain before we try again; ordinary blips back off gently.
    const resource = /INSUFFICIENT_RESOURCES|ERR_NETWORK/i.test((err && err.message) || "");
    await new Promise((res) => setTimeout(res, (resource ? 2500 : 800) * attempt));
  }
}

async function fetchText(url, signal, id) {
  return new TextDecoder().decode(await fetchBytesRobust(url, signal, id));
}

async function fetchBuf(url, signal, id) {
  return fetchBytesRobust(url, signal, id);
}

function hexToBytes(hex) {
  const clean = hex.replace(/^0x/i, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// --- playlist parsing ------------------------------------------------------

function isMaster(text) {
  return text.includes("#EXT-X-STREAM-INF");
}

function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  const audio = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/.test(line)) {
      const group = (/GROUP-ID="([^"]+)"/.exec(line) || [])[1];
      const uri = (/URI="([^"]+)"/.exec(line) || [])[1];
      const isDefault = /DEFAULT=YES/.test(line);
      if (uri) audio.push({ group, url: new URL(uri, baseUrl).href, isDefault });
    } else if (line.startsWith("#EXT-X-STREAM-INF")) {
      const bw = (/BANDWIDTH=(\d+)/.exec(line) || [])[1];
      const res = /RESOLUTION=(\d+)x(\d+)/.exec(line);
      const audioGroup = (/AUDIO="([^"]+)"/.exec(line) || [])[1];
      const uri = lines[i + 1] && !lines[i + 1].startsWith("#") ? lines[i + 1].trim() : null;
      if (uri) {
        variants.push({
          bandwidth: bw ? +bw : 0,
          height: res ? +res[2] : 0,
          audioGroup,
          url: new URL(uri, baseUrl).href,
        });
      }
    }
  }
  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  return { variants, audio };
}

function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let key = null;
  let map = null;
  let seq = 0;
  let duration = 0; // sum of #EXTINF — the real length, to fix bogus container durations
  // No #EXT-X-ENDLIST and no PLAYLIST-TYPE:VOD = a live/event stream that's still
  // appending segments. Downloading it would silently save just the current window.
  const live = !/#EXT-X-ENDLIST/i.test(text) && !/#EXT-X-PLAYLIST-TYPE:\s*VOD/i.test(text);
  const seqMatch = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text);
  if (seqMatch) seq = +seqMatch[1];
  let idx = seq;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF")) {
      duration += parseFloat(line.slice(8).split(",")[0]) || 0;
    } else if (line.startsWith("#EXT-X-KEY")) {
      const method = (/METHOD=([^,]+)/.exec(line) || [])[1];
      const uri = (/URI="([^"]+)"/.exec(line) || [])[1];
      const iv = (/IV=0x([0-9A-Fa-f]+)/.exec(line) || [])[1];
      key = method && method !== "NONE" ? { method, uri: uri ? new URL(uri, baseUrl).href : null, iv } : null;
    } else if (line.startsWith("#EXT-X-MAP")) {
      const uri = (/URI="([^"]+)"/.exec(line) || [])[1];
      if (uri) map = new URL(uri, baseUrl).href;
    } else if (line && !line.startsWith("#")) {
      segments.push({ url: new URL(line, baseUrl).href, key, seq: idx });
      idx++;
    }
  }
  return { segments, map, duration, live };
}

// --- DASH (.mpd) parsing ---------------------------------------------------
// MPEG-DASH is what many lecture platforms (e.g. Physics Wallah) use. It's an
// XML manifest describing video + audio Representations as fMP4 init+segments —
// which map cleanly onto our existing assembleMedia()/ffMux() pipeline. We handle
// the common SegmentTemplate form (with SegmentTimeline or @duration). CENC/DRM
// (Widevine/PlayReady) can't be decrypted, so we detect and reject it clearly.

function parseIsoDuration(s) {
  if (!s) return 0;
  const m = /P(?:\d+Y)?(?:\d+M)?(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(s);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

// Namespace-agnostic element helpers — DASH manifests carry a default xmlns, so
// querySelector("MPD") returns null. Match on local name in ANY namespace.
function dashEls(parent, name) {
  return parent ? [...parent.getElementsByTagNameNS("*", name)] : [];
}
function dashEl(parent, name) {
  return dashEls(parent, name)[0] || null;
}
function dashChild(parent, name) {
  return [...parent.children].find((c) => c.localName === name) || null;
}

function dashBaseURL(el, parentBase) {
  const b = dashChild(el, "BaseURL");
  if (b && b.textContent.trim()) {
    try {
      return new URL(b.textContent.trim(), parentBase).href;
    } catch {}
  }
  return parentBase;
}

function fillDashTemplate(tmpl, repId, number, time, bandwidth) {
  return tmpl
    .replace(/\$RepresentationID\$/g, repId)
    .replace(/\$Bandwidth\$/g, String(bandwidth))
    .replace(/\$Number(%0\d+d)?\$/g, (mm, fmt) =>
      fmt ? String(number).padStart(+fmt.slice(2, -1), "0") : String(number)
    )
    .replace(/\$Time\$/g, String(time))
    .replace(/\$\$/g, "$");
}

function dashSegmentsFromTemplate(st, base, repId, bandwidth, totalDur) {
  const timescale = +(st.getAttribute("timescale") || "1") || 1;
  const initTmpl = st.getAttribute("initialization");
  const mediaTmpl = st.getAttribute("media");
  const startNumber = +(st.getAttribute("startNumber") || "1");
  const map = initTmpl
    ? new URL(fillDashTemplate(initTmpl, repId, 0, 0, bandwidth), base).href
    : null;
  const segments = [];
  const timeline = dashChild(st, "SegmentTimeline");
  if (timeline && mediaTmpl) {
    let number = startNumber;
    let time = 0;
    for (const S of dashEls(timeline, "S")) {
      const t = S.getAttribute("t");
      if (t != null) time = +t;
      const d = +S.getAttribute("d");
      let r = +(S.getAttribute("r") || "0");
      if (r < 0) r = Math.max(0, Math.ceil((totalDur * timescale - time) / d) - 1); // until period end
      for (let k = 0; k <= r; k++) {
        segments.push({ url: new URL(fillDashTemplate(mediaTmpl, repId, number, time, bandwidth), base).href, key: null, seq: number });
        number++;
        time += d;
      }
    }
  } else if (mediaTmpl) {
    // duration-based: fixed segment duration → count from total length
    const dur = +(st.getAttribute("duration") || "0");
    if (dur > 0 && totalDur > 0) {
      const n = Math.ceil((totalDur * timescale) / dur);
      for (let i = 0; i < n; i++) {
        const number = startNumber + i;
        segments.push({ url: new URL(fillDashTemplate(mediaTmpl, repId, number, i * dur, bandwidth), base).href, key: null, seq: number });
      }
    }
  }
  return { map, segments };
}

function parseDash(xmlText, baseUrl) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (dashEl(doc, "parsererror")) throw new Error("Couldn't parse the DASH manifest (invalid XML).");
  const mpd = dashEl(doc, "MPD");
  if (!mpd) throw new Error("Not a DASH manifest.");
  const totalDur = parseIsoDuration(mpd.getAttribute("mediaPresentationDuration"));
  const mpdBase = dashBaseURL(mpd, baseUrl);
  const period = dashEl(mpd, "Period");
  if (!period) throw new Error("DASH manifest has no Period.");
  const periodBase = dashBaseURL(period, mpdBase);
  const sets = dashEls(period, "AdaptationSet");

  // DRM: any ContentProtection scheme that isn't the generic mp4 protection
  // marker or plain ClearKey means encrypted segments we can't decrypt.
  const cps = dashEls(period, "ContentProtection");
  const drm = cps.some((c) => {
    const u = (c.getAttribute("schemeIdUri") || "").toLowerCase();
    return u && !/clearkey/.test(u) && u !== "urn:mpeg:dash:mp4protection:2011";
  });

  const setKind = (set) => {
    const mt = (set.getAttribute("mimeType") || set.getAttribute("contentType") || "").toLowerCase();
    if (mt.startsWith("video")) return "video";
    if (mt.startsWith("audio")) return "audio";
    const rep = dashEl(set, "Representation");
    const rmt = ((rep && rep.getAttribute("mimeType")) || "").toLowerCase();
    if (rmt.startsWith("video")) return "video";
    if (rmt.startsWith("audio")) return "audio";
    return "other";
  };

  const pick = (kind) => {
    const set = sets.find((s) => setKind(s) === kind);
    if (!set) return null;
    const setBase = dashBaseURL(set, periodBase);
    const reps = dashEls(set, "Representation").sort(
      (a, b) => (+b.getAttribute("bandwidth") || 0) - (+a.getAttribute("bandwidth") || 0)
    );
    const rep = reps[0];
    if (!rep) return null;
    const repBase = dashBaseURL(rep, setBase);
    const repId = rep.getAttribute("id") || "";
    const bandwidth = rep.getAttribute("bandwidth") || "0";
    const st = dashChild(rep, "SegmentTemplate") || dashChild(set, "SegmentTemplate");
    if (st) return dashSegmentsFromTemplate(st, repBase, repId, bandwidth, totalDur);
    // No SegmentTemplate → a single self-contained file (BaseURL). Download whole.
    return { map: null, segments: [{ url: repBase, key: null, seq: 0 }] };
  };

  return { video: pick("video"), audio: pick("audio"), drm };
}

async function runDash(job) {
  const { id, url, concurrency, mode = "video" } = job;
  const conn = concurrency || DEFAULT_CONCURRENCY;

  const xml = await pausableFetch(id, (s) => fetchText(url, s, id));
  const dash = parseDash(xml, url);
  if (dash.drm) {
    throw new Error("This lecture is DRM-protected (Widevine) — it can't be downloaded, only streamed.");
  }
  if (!dash.video || !dash.video.segments.length) {
    throw new Error("No downloadable video track found in the DASH manifest.");
  }
  const hasAudio = dash.audio && dash.audio.segments.length > 0;
  const counter = { done: 0, total: dash.video.segments.length + (hasAudio ? dash.audio.segments.length : 0) };

  const video = await assembleMedia(dash.video, id, conn, counter);
  const audio = hasAudio ? await assembleMedia(dash.audio, id, conn, counter) : null;

  // DASH media segments are fMP4 → mux/remux into a clean mp4.
  await withConvertLock(id, async () => {
    const base = audio
      ? await ffMux(await blobBytes(video.blob), "mp4", await blobBytes(audio.blob), "mp4")
      : await ffRemux(await blobBytes(video.blob), "mp4");
    await emitWithMode(id, base, "mp4", job);
  });
}

// --- decryption (AES-128 CBC) ----------------------------------------------

const keyCache = new Map();

async function decryptSegment(buf, keyInfo, signal, id) {
  let raw = keyCache.get(keyInfo.uri);
  if (!raw) {
    raw = await fetchBuf(keyInfo.uri, signal, id);
    if (keyCache.size > 50) keyCache.clear(); // don't hold keys forever across jobs
    keyCache.set(keyInfo.uri, raw);
  }
  const cryptoKey = await crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]);
  let iv;
  if (keyInfo.iv) {
    iv = hexToBytes(keyInfo.iv);
  } else {
    iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, keyInfo.seq >>> 0);
  }
  const out = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, buf);
  return new Uint8Array(out);
}

// Assemble one media playlist into a single byte array (init + segments).
async function assembleMedia(media, id, concurrency, counter) {
  const encrypted = media.segments.find((s) => s.key);
  if (encrypted && encrypted.key.method !== "AES-128") {
    throw new Error(`Stream uses ${encrypted.key.method} encryption (DRM) — cannot download.`);
  }

  const parts = [];
  if (media.map) parts.push(await pausableFetch(id, (s) => fetchBuf(media.map, s, id)));

  // Roll completed segments into sub-Blobs as we go (a Blob can spill to disk;
  // Uint8Arrays cannot). Holding EVERY segment in the JS heap until the end made
  // peak memory ≈ the whole stream — a multi-GB merge crashed the offscreen doc
  // before the final Blob was ever built. Segments finish out of order (parallel
  // workers), so we flush only the contiguous prefix; the in-flight window stays
  // bounded by concurrency × segment size + FLUSH_AT.
  const buffers = new Array(media.segments.length);
  // Per-segment byte sizes — used by the TS->MP4 remux to flush mux.js on segment
  // (keyframe-aligned) boundaries. Recorded before the buffers are released.
  const segSizes = new Array(media.segments.length).fill(0);
  const FLUSH_AT = 64 * 1024 * 1024;
  let flushedUpTo = 0;
  let pending = [];
  let pendingBytes = 0;
  const flushContiguous = () => {
    while (flushedUpTo < buffers.length && buffers[flushedUpTo]) {
      const b = buffers[flushedUpTo];
      buffers[flushedUpTo] = null; // release the reference — the Blob owns it now
      flushedUpTo++;
      pending.push(b);
      pendingBytes += b.byteLength;
      if (pendingBytes >= FLUSH_AT) {
        parts.push(new Blob(pending));
        pending = [];
        pendingBytes = 0;
      }
    }
  };

  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= media.segments.length) return;
      const seg = media.segments[i];
      let buf = await pausableFetch(id, (s) => fetchBuf(seg.url, s, id));
      if (seg.key) buf = await decryptSegment(buf, { ...seg.key, seq: seg.seq }, getControl(id).abort.signal, id);
      segSizes[i] = buf.byteLength;
      buffers[i] = buf;
      flushContiguous();
      counter.done++;
      if (counter.done % 3 === 0 || counter.done === counter.total) {
        postProgress(id, counter.done, counter.total);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, media.segments.length || 1) }, worker));
  flushContiguous();
  if (pending.length) {
    parts.push(new Blob(pending));
    pending = [];
  }

  // Return a Blob, NOT a giant Uint8Array. ArrayBuffer is capped at ~2GB, so a
  // long video (e.g. a 48-min stream) throws NotReadableError when materialized
  // here. A Blob has no such limit and the raw-save path saves it directly.
  const blob = new Blob(parts, { type: media.map ? "video/mp4" : "video/mp2t" });
  return { blob, isFmp4: !!media.map, segSizes };
}

// Materialize a Blob to bytes for ffmpeg. This DOES hit the ~2GB ArrayBuffer cap —
// but only conversions (which are memory-bound anyway) call it; plain raw saves
// use the Blob directly and work at any size.
async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

// --- emit final output according to the chosen mode ------------------------

function addSuffix(filename, suffix) {
  return filename.replace(/(\.[a-z0-9]{2,4})$/i, suffix + "$1");
}

// Given a combined MP4 (or raw) source, produce the requested artifact.
async function emitWithMode(id, srcBytes, srcExt, job) {
  const { mode = "video", start = 0, end = 0, filename } = job;

  if (mode === "audio") {
    const a = await ffExtractAudio(srcBytes, srcExt);
    saveBlob(id, new Blob([a.bytes], { type: a.type }), ensureExt(filename, a.ext));
    return;
  }
  if (mode === "clip") {
    const out = await ffClip(srcBytes, srcExt, start, end);
    saveBlob(id, new Blob([out], { type: "video/mp4" }), addSuffix(ensureExt(filename, ".mp4"), "_clip"));
    return;
  }
  if (mode === "gif") {
    const dur = Math.min(Math.max((end || start + 5) - start, 1), 20); // cap 20s
    const out = await ffGif(srcBytes, srcExt, start, dur);
    saveBlob(id, new Blob([out], { type: "image/gif" }), ensureExt(filename, ".gif"));
    return;
  }
  // plain video
  saveBlob(
    id,
    new Blob([srcBytes], { type: srcExt === "mp4" ? "video/mp4" : "video/mp2t" }),
    ensureExt(filename, srcExt === "mp4" ? ".mp4" : ".ts")
  );
}

// --- main HLS flow ---------------------------------------------------------

async function runHls(job) {
  const { id, url, masterUrl, concurrency, convert, mode = "video" } = job;
  const conn = concurrency || DEFAULT_CONCURRENCY;

  // Resolve which media playlist is the video, and whether there's a separate
  // audio track (defined only in the master playlist).
  let videoUrl = url;
  let audioInfo = null;

  const masterText = await pausableFetch(id, (s) => fetchText(masterUrl || url, s, id));
  if (isMaster(masterText)) {
    const master = parseMaster(masterText, masterUrl || url);
    const chosen =
      url && url !== (masterUrl || url) ? master.variants.find((v) => v.url === url) : null;
    const variant = chosen || master.variants[0];
    if (variant) videoUrl = variant.url;
    if (master.audio.length) {
      const grp = variant && variant.audioGroup;
      audioInfo =
        master.audio.find((a) => a.group === grp && a.isDefault) ||
        master.audio.find((a) => a.group === grp) ||
        master.audio.find((a) => a.isDefault) ||
        master.audio[0];
    }
  } else {
    videoUrl = url || masterUrl;
  }

  // Audio-only: if there's a separate audio rendition, fetch just that (saves
  // bandwidth); otherwise fall through and pull audio out of the muxed video.
  if (mode === "audio" && audioInfo) {
    const audioMedia = parseMedia(await pausableFetch(id, (s) => fetchText(audioInfo.url, s, id)), audioInfo.url);
    if (audioMedia.live) {
      throw new Error("This is a LIVE stream (still broadcasting) — only the current buffer window exists, so it can't be downloaded as a complete file. Try again after the stream ends.");
    }
    const counter = { done: 0, total: audioMedia.segments.length };
    const audio = await assembleMedia(audioMedia, id, conn, counter);
    await withConvertLock(id, async () => {
      await emitWithMode(id, await blobBytes(audio.blob), audio.isFmp4 ? "mp4" : "ts", job);
    });
    return;
  }

  const videoMedia = parseMedia(await pausableFetch(id, (s) => fetchText(videoUrl, s, id)), videoUrl);
  if (!videoMedia.segments.length) throw new Error("No video segments found in the playlist.");
  if (videoMedia.live) {
    throw new Error("This is a LIVE stream (still broadcasting) — only the current buffer window exists, so it can't be downloaded as a complete file. Try again after the stream ends.");
  }
  const audioMedia = audioInfo
    ? parseMedia(await pausableFetch(id, (s) => fetchText(audioInfo.url, s, id)), audioInfo.url)
    : null;

  const counter = {
    done: 0,
    total: videoMedia.segments.length + (audioMedia ? audioMedia.segments.length : 0),
  };

  const video = await assembleMedia(videoMedia, id, conn, counter);
  const audio = audioMedia ? await assembleMedia(audioMedia, id, conn, counter) : null;
  const vExt = video.isFmp4 ? "mp4" : "ts";
  const realDur = videoMedia.duration || 0; // sum of #EXTINF — the true length

  // Modes other than plain "video" REQUIRE ffmpeg. Plain video can fall back to
  // a raw save if ffmpeg is unavailable.
  const biggest = Math.max(video.blob.size, audio ? audio.blob.size : 0);
  console.log(`[VideoCatch][offscreen] runHls done fetching: mode=${mode} convert=${convert} isFmp4=${video.isFmp4}`);

  // --- Convert a plain video to MP4 at ANY size --------------------------------
  // Uses the streaming TS→MP4 remux (mux.js) / direct fMP4 save so there's no 2GB
  // ffmpeg limit. ffmpeg is only needed for separate audio+video tracks.
  if (mode === "video" && convert) {
    console.log(
      `[VideoCatch][offscreen] convert path: separateAudio=${!!audio} isFmp4=${video.isFmp4} ` +
        `videoMB=${Math.round(video.blob.size / 1e6)}` + (audio ? ` audioMB=${Math.round(audio.blob.size / 1e6)}` : "")
    );
    // Returns true if the file was saved here; false → fall through to the raw save.
    const saved = await withConvertLock(id, async () => {
      try {
        if (!audio && video.isFmp4) {
          // Concatenated fMP4 is a valid MP4 — but some streams carry a BOGUS container
          // duration (plays to real length, then a multi-hour black tail that crashes
          // players — the "13-hour" file). If we know the real length (sum of #EXTINF)
          // and it fits, remux with -t to stamp the correct duration; else save as-is.
          if (realDur > 0 && video.blob.size <= CONVERT_MAX_BYTES) {
            try {
              const fixed = await ffRemux(await blobBytes(video.blob), "mp4", "mp4", realDur);
              saveBlob(id, new Blob([fixed], { type: "video/mp4" }), ensureExt(job.filename, ".mp4"));
              return true;
            } catch (e) {
              console.warn("[VideoCatch][offscreen] fMP4 duration-fix failed, saving raw:", e);
            }
          }
          saveBlob(id, video.blob, ensureExt(job.filename, ".mp4"));
          return true;
        }
        if (!audio && !video.isFmp4) {
          // MPEG-TS → MP4 via streaming remux — works for multi-GB files. Pass the
          // real playlist duration so a discontinuity-inflated "13-hour" file is fixed.
          const mp4 = await remuxTsBlobToMp4(video.blob, video.segSizes, id, realDur);
          saveBlob(id, mp4, ensureExt(job.filename, ".mp4"));
          return true;
        }
        // Separate audio+video → ffmpeg mux (in-memory, ~2GB cap).
        if (biggest <= CONVERT_MAX_BYTES) {
          const base = await ffMux(await blobBytes(video.blob), vExt, await blobBytes(audio.blob), audio.isFmp4 ? "mp4" : "ts", "mp4", realDur);
          await emitWithMode(id, base, "mp4", job);
          return true;
        }
        chrome.runtime.sendMessage({ type: "hls-warn", id, warn: "too-large-to-convert" });
      } catch (e) {
        console.error("[VideoCatch][offscreen] convert failed, saving raw:", (e && e.stack) || e);
        chrome.runtime.sendMessage({ type: "hls-warn", id, warn: "convert-failed" });
      }
      return false; // convert failed / too large → fall through to the raw save
    });
    if (saved) return;
  }

  // --- clip / gif / mp3 — require ffmpeg, so bound by the ~2GB ArrayBuffer ------
  if (mode !== "video") {
    if (biggest > CONVERT_MAX_BYTES) {
      throw new Error(`This stream is ${Math.round(biggest / 1e6)} MB — too large to ${mode} in the browser (~2GB max).`);
    }
    await withConvertLock(id, async () => {
      const base = audio
        ? await ffMux(await blobBytes(video.blob), vExt, await blobBytes(audio.blob), audio.isFmp4 ? "mp4" : "ts")
        : await ffRemux(await blobBytes(video.blob), vExt);
      await emitWithMode(id, base, "mp4", job);
    });
    return;
  }

  // --- Plain video, no conversion → raw save (Blob direct, any size) -----------
  saveBlob(id, video.blob, ensureExt(job.filename, video.isFmp4 ? ".mp4" : ".ts"));
}

// --- YouTube capture mux (fMP4 video + audio tracks from the page hook) -----

// captureId -> Map(trackId -> track). Fragments are STREAMED here live during
// the capture (the page holds nothing), decoded once and rolled into 32MB
// sub-Blobs (disk-backable) — so capture size is no longer bounded by the
// YouTube tab's memory OR this document's JS heap. Each fragment's tfdt decode
// time + byte position is kept in `index`, so at mux time we can reassemble a
// clean time-ordered stream with cheap Blob.slice() references (no copying).
const captures = new Map();

function capTrack(captureId, trackId, kind, mime) {
  let cap = captures.get(captureId);
  if (!cap) {
    cap = new Map();
    captures.set(captureId, cap);
  }
  let tr = cap.get(trackId);
  if (!tr) {
    tr = { kind: kind || "other", mime: mime || "", init: null, first: null, blobs: [], pending: [], pendingBytes: 0, bytes: 0, index: [] };
    cap.set(trackId, tr);
  }
  if (kind && tr.kind === "other") tr.kind = kind;
  if (mime && !tr.mime) tr.mime = mime;
  return tr;
}

function capAppend(tr, bytes, t) {
  if (!tr.first) tr.first = bytes.slice(0, 16);
  tr.index.push({ t: t == null || !isFinite(t) ? null : t, size: bytes.byteLength, pos: tr.bytes });
  tr.bytes += bytes.byteLength;
  tr.pending.push(bytes);
  tr.pendingBytes += bytes.byteLength;
  if (tr.pendingBytes >= 32 * 1024 * 1024) {
    tr.blobs.push(new Blob(tr.pending));
    tr.pending = [];
    tr.pendingBytes = 0;
  }
}

// Time-order the fragment index (the player appends in playback/seek order, not
// time order) and drop exact re-fetches (same time AND size). If most fragments
// carry no readable tfdt, keep append order — reordering on bad data would
// scramble a good stream.
function orderedIndex(index) {
  const withT = index.filter((e) => e.t != null).length;
  if (withT < index.length * 0.6) return index.slice();
  const s = index.slice().sort((a, b) => (a.t == null ? Infinity : a.t) - (b.t == null ? Infinity : b.t) || a.pos - b.pos);
  const out = [];
  let lastT = NaN;
  let lastSize = -1;
  for (const e of s) {
    if (e.t != null && e.t === lastT && e.size === lastSize) continue;
    out.push(e);
    lastT = e.t == null ? NaN : e.t;
    lastSize = e.size;
  }
  return out;
}

// Build the final track stream: init + time-ordered fragments, as a Blob of
// lazy slices into the raw captured Blob — no byte copying, any size.
function trackBlob(tr, type) {
  if (tr.pending.length) {
    tr.blobs.push(new Blob(tr.pending));
    tr.pending = [];
    tr.pendingBytes = 0;
  }
  const raw = new Blob(tr.blobs);
  const ord = orderedIndex(tr.index);
  const parts = [];
  if (tr.init) parts.push(tr.init);
  for (const e of ord) parts.push(raw.slice(e.pos, e.pos + e.size));
  return new Blob(parts, { type });
}

// mdhd timescale (ticks/second) from an init segment — converts tfdt ticks to
// seconds. moov > trak > mdia > mdhd; v0 keeps it at +20, v1 at +28.
function mp4Timescale(init) {
  try {
    if (!init || init.byteLength < 16) return 0;
    const dv = new DataView(init.buffer, init.byteOffset, init.byteLength);
    const type = (o) => String.fromCharCode(init[o + 4], init[o + 5], init[o + 6], init[o + 7]);
    let found = 0;
    const walk = (start, end) => {
      let o = start;
      while (o + 8 <= end && !found) {
        let size = dv.getUint32(o);
        if (size === 1) {
          if (o + 16 > end) break;
          size = dv.getUint32(o + 8) * 4294967296 + dv.getUint32(o + 12);
        } else if (size === 0) size = end - o;
        if (size < 8 || o + size > end) break;
        const t = type(o);
        if (t === "mdhd") {
          found = init[o + 8] === 1 ? dv.getUint32(o + 28) : dv.getUint32(o + 20);
          return;
        }
        if (t === "moov" || t === "trak" || t === "mdia") walk(o + 8, o + size);
        o += size;
      }
    };
    walk(0, init.byteLength);
    return found || 0;
  } catch {
    return 0;
  }
}

// A track's fragment start times in SECONDS (sorted), and its own start.
function trackTimes(tr) {
  const ts = tr.init ? mp4Timescale(tr.init) : 0;
  if (!ts) return { start: -1, frags: [] };
  const frags = [];
  for (const e of tr.index) if (e.t != null) frags.push(e.t / ts);
  frags.sort((a, b) => a - b);
  return { start: frags.length ? frags[0] : -1, frags };
}

// The trim/alignment plan for a capture — PURE function (mirrored in tests).
// Handles BOTH problems with one mechanism: ffmpeg normalizes each input file
// independently, so whenever the video and audio tracks don't start at the same
// media time (any capture that began mid-video — not just range clips), each
// input needs its own seek aimed at the same content instant. That instant is a
// video keyframe (= a fragment start) so the copy-cut is clean.
function ytTrimPlan(vT, aStart, hasRange, rangeStart, rangeEnd) {
  const vStart = vT.start;
  let vSeek = 0;
  let aSeek = null;
  let clipDur = 0;
  if (vStart < 0) {
    if (hasRange) clipDur = rangeEnd - rangeStart + 8; // end clamp only
    return { vSeek, aSeek, clipDur };
  }
  let target = null;
  if (hasRange && rangeStart >= vStart - 1 && rangeStart - vStart < 7200) {
    target = Math.max(rangeStart, vStart);
  } else if (!hasRange && aStart >= 0 && Math.abs(aStart - vStart) >= 0.3 && Math.abs(aStart - vStart) < 90) {
    // Full capture whose tracks start apart (e.g. capture began mid-video) —
    // align them at the later start so neither leads the other.
    target = Math.max(vStart, aStart);
  }
  if (target == null) {
    if (hasRange) clipDur = rangeEnd - rangeStart + 8;
    return { vSeek, aSeek, clipDur };
  }
  let kf = -1;
  for (const s of vT.frags) if (s <= target + 0.25 && s > kf) kf = s;
  if (kf < 0) kf = vStart;
  // +0.1 lands each seek just past the keyframe so ffmpeg snaps back ONTO it.
  vSeek = Math.max(0, kf - vStart) + 0.1;
  if (aStart >= 0 && Math.abs(kf - aStart) < 120) aSeek = Math.max(0, kf - aStart) + 0.1;
  clipDur = hasRange ? Math.max(1, rangeEnd - kf) : 0;
  return { vSeek, aSeek, clipDur };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}


async function runYtMux(captureId, id, filename, durationSec = 0, rangeStart = 0, rangeEnd = 0) {
  const cap = captures.get(captureId);
  captures.delete(captureId);
  const tracks = cap ? [...cap.values()] : [];
  const pickK = (kind) => tracks.filter((t) => t.kind === kind && t.bytes > 0).sort((a, b) => b.bytes - a.bytes)[0] || null;
  const vTr = pickK("video") || pickK("other");
  const aTr = pickK("audio");
  if (!vTr || !vTr.bytes) {
    throw new Error("Nothing captured yet — play the video so it buffers, then Save.");
  }
  const hasAudio = !!(aTr && aTr.bytes);

  // Container/codec sniffing — mp4 output only for H.264 + AAC/mp4; anything
  // else goes to mkv, which copies any codec combo losslessly.
  const vC = sniffContainer(vTr.init || vTr.first || new Uint8Array(0));
  const aC = hasAudio ? sniffContainer(aTr.init || aTr.first || new Uint8Array(0)) : null;
  const vMime = (vTr.mime || "").toLowerCase();
  const aMime = ((aTr && aTr.mime) || "").toLowerCase();
  const h264 = /avc1|avc3|h\.?264/.test(vMime);
  const aacOk = !hasAudio || aC === "mp4" || /mp4a|aac/.test(aMime);
  const mp4Clean = vC === "mp4" && aacOk && (vMime ? h264 : aC !== "webm");

  // Timing comes from the SHIPPED DATA itself (fragment tfdt ÷ mdhd timescale) —
  // ground truth, no page-side estimates. ytTrimPlan handles both range trimming
  // and A/V alignment for ANY capture whose tracks don't start together (e.g. a
  // capture that began mid-video), since ffmpeg normalizes each input on its own.
  const vT = trackTimes(vTr);
  const aStart = hasAudio ? trackTimes(aTr).start : -1;
  const hasRange = rangeEnd > 0 && rangeEnd > rangeStart;
  const { vSeek, aSeek, clipDur } = ytTrimPlan(vT, aStart, hasRange, rangeStart, rangeEnd);

  // Diagnostic snapshot — if a mux ever degrades to the split save, this line in
  // the offscreen console says exactly what the muxer was given and decided.
  console.log(
    `[VideoCatch][yt-mux] video=${Math.round(vTr.bytes / 1e6)}MB init=${!!vTr.init} frags=${vTr.index.length} start=${vT.start.toFixed ? vT.start.toFixed(2) : vT.start}` +
      (hasAudio ? ` | audio=${Math.round(aTr.bytes / 1e6)}MB init=${!!aTr.init} start=${aStart.toFixed ? aStart.toFixed(2) : aStart}` : " | no-audio") +
      ` | vC=${vC} aC=${aC} mp4Clean=${mp4Clean} | vSeek=${vSeek} aSeek=${aSeek} clipDur=${clipDur} range=${hasRange ? rangeStart + "-" + rangeEnd : "full"}`
  );
  if (!vTr.init && vC === "mp4") {
    console.warn("[VideoCatch][yt-mux] video track has NO init segment — the stream likely lost its codec config (ordering/wipe issue); mux will probably fail.");
  }

  // Assemble each track ONCE as a Blob of ordered slices (no byte copying) and
  // mux via WORKERFS — inputs are read lazily from disk, only the output touches
  // the wasm heap, so any capture size muxes the same way.
  const vBlob = trackBlob(vTr, vC === "webm" ? "video/webm" : "video/mp4");
  const aBlob = hasAudio ? trackBlob(aTr, aC === "webm" ? "audio/webm" : "audio/mp4") : null;

  await withConvertLock(id, async () => {
    let out = null;
    let outExt = mp4Clean ? "mp4" : "mkv";
    try {
      out = await ffMuxMounted(vBlob, aBlob, outExt, clipDur, vSeek, aSeek);
    } catch (e) {
      console.warn(`[VideoCatch][yt-mux] ${outExt} attempt failed:`, (e && e.message) || e);
      // Retry as mkv (copy holds anything). Blobs aren't consumed by a failed
      // attempt, so retries just work — no detached-buffer dance.
      if (outExt === "mp4") {
        try {
          outExt = "mkv";
          out = await ffMuxMounted(vBlob, aBlob, outExt, clipDur, vSeek, aSeek);
        } catch (e2) {
          console.warn("[VideoCatch][yt-mux] mkv attempt failed:", (e2 && e2.message) || e2);
          out = null;
        }
      }
      // A broken/truncated AUDIO track shouldn't lose the whole video —
      // video-only mkv as the next resort.
      if (out == null) {
        if (hasAudio) {
          outExt = "mkv";
          try {
            out = await ffMuxMounted(vBlob, null, outExt, clipDur, vSeek, null);
          } catch (e3) {
            console.warn("[VideoCatch][yt-mux] video-only attempt failed:", (e3 && e3.message) || e3);
            out = null;
          }
        } else {
          throw e;
        }
      }
    }

    // TRUE last resort: save the raw tracks as separate playable files.
    if (out == null) {
      const vExt = vC === "webm" ? "webm" : "mp4";
      saveBlob(id, vBlob, hasAudio ? addSuffix(ensureExt(filename, "." + vExt), "_video") : ensureExt(filename, "." + vExt));
      if (aBlob) {
        const aExt = aC === "webm" ? "weba" : "m4a";
        const aUrl = URL.createObjectURL(aBlob);
        anchorSave(aUrl, addSuffix(ensureExt(filename, "." + aExt), "_audio"));
        setTimeout(() => {
          try {
            URL.revokeObjectURL(aUrl);
          } catch {}
        }, 15 * 60 * 1000);
        chrome.runtime.sendMessage({ type: "hls-warn", id, warn: "yt-split" });
      }
      return;
    }

    const outType = outExt === "mp4" ? "video/mp4" : "video/x-matroska";
    const base = hasRange ? addSuffix(ensureExt(filename, "." + outExt), "_clip") : ensureExt(filename, "." + outExt);
    saveBlob(id, new Blob([out], { type: outType }), base);
  });
}

// --- Reddit: fetch the video track + the separate audio track, then mux ------
// Reddit's packaged/CMAF video is silent (audio is a separate CMAF_AUDIO file).
// Both are complete MP4s, so a stream-copy mux is instant; ffMux re-encodes only
// if copy can't drop the codecs into the container.
async function runRedditAV(job) {
  const { id, videoUrl, audioUrl, filename, mode = "video" } = job;
  chrome.runtime.sendMessage({ type: "hls-progress", id, done: 0, total: 3 });
  const vBytes = await pausableFetch(id, (s) => fetchBuf(videoUrl, s, id));
  chrome.runtime.sendMessage({ type: "hls-progress", id, done: 1, total: 3 });

  let aBytes = null;
  if (audioUrl) {
    try {
      aBytes = await pausableFetch(id, (s) => fetchBuf(audioUrl, s, id));
    } catch {
      aBytes = null; // audio fetch failed — save video-only rather than nothing
    }
  }
  chrome.runtime.sendMessage({ type: "hls-progress", id, done: 2, total: 3 });
  await checkpoint(id);

  // Combine video + audio into one MP4 (or keep video-only if there's no audio),
  // then route through emitWithMode so Clip / GIF / MP3 (and plain video) all work.
  let mp4Bytes = vBytes;
  const hasAudio = !!(aBytes && aBytes.length);
  if (hasAudio || (mode && mode !== "video")) {
    await withConvertLock(id, async () => {
      if (hasAudio) mp4Bytes = await ffMux(vBytes, "mp4", aBytes, "mp4", "mp4");
      if (mode && mode !== "video") {
        await emitWithMode(id, mp4Bytes, "mp4", job);
      } else {
        saveBlob(id, new Blob([mp4Bytes], { type: "video/mp4" }), ensureExt(filename, ".mp4"));
      }
    });
    return;
  }
  saveBlob(id, new Blob([mp4Bytes], { type: "video/mp4" }), ensureExt(filename, ".mp4"));
}

// --- accelerated progressive download (parallel byte ranges) ---------------

async function runFile(job) {
  const { id, url, filename, concurrency, size, maxBytes, mode = "video" } = job;
  const conn = concurrency || DEFAULT_CONCURRENCY;

  // Probe for range support (tiny request, not pausable — pause/cancel is caught
  // a beat later in the worker loop).
  let total = size;
  let canRange = false;
  try {
    const probe = await fetch(url, { headers: { Range: "bytes=0-1" }, credentials: "include" });
    if (probe.status === 206) {
      canRange = true;
      const cr = probe.headers.get("Content-Range");
      if (!total && cr) total = parseInt(cr.split("/")[1], 10);
    }
  } catch {}

  let bytes;

  if (canRange && total && isFinite(total)) {
    // Plain video too big to hold in memory → let the browser handle it.
    if (mode === "video" && maxBytes && total > maxBytes) throw new Error("too large");
    if (mode !== "video" && total > FFMPEG_MAX_BYTES) {
      throw new Error(`File is ${Math.round(total / 1e6)} MB — too large to ${mode} in-browser.`);
    }

    const ranges = [];
    for (let start = 0; start < total; start += CHUNK) {
      ranges.push([start, Math.min(start + CHUNK - 1, total - 1)]);
    }
    // Roll completed chunks into sub-Blobs as they finish (contiguous prefix only —
    // workers complete out of order) so peak JS-heap stays bounded instead of
    // holding the whole file in Uint8Arrays until the end.
    const buffers = new Array(ranges.length);
    const blobParts = [];
    const FLUSH_AT = 64 * 1024 * 1024;
    let flushedUpTo = 0;
    let pending = [];
    let pendingBytes = 0;
    const flushContiguous = () => {
      while (flushedUpTo < buffers.length && buffers[flushedUpTo]) {
        const b = buffers[flushedUpTo];
        buffers[flushedUpTo] = null;
        flushedUpTo++;
        pending.push(b);
        pendingBytes += b.byteLength;
        if (pendingBytes >= FLUSH_AT) {
          blobParts.push(new Blob(pending));
          pending = [];
          pendingBytes = 0;
        }
      }
    };
    let next = 0;
    let done = 0;
    async function worker() {
      while (true) {
        const i = next++;
        if (i >= ranges.length) return;
        const [s, e] = ranges[i];
        buffers[i] = await pausableFetch(id, async (sig) => {
          const r = await fetch(url, { headers: { Range: `bytes=${s}-${e}` }, credentials: "include", signal: sig });
          if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        });
        flushContiguous();
        done++;
        postProgress(id, done, ranges.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(conn, ranges.length) }, worker));
    flushContiguous();
    if (pending.length) {
      blobParts.push(new Blob(pending));
      pending = [];
    }
    // Plain video → save the assembled parts as a Blob directly (no giant
    // ArrayBuffer, so files over ~2GB work). Only convert modes materialize bytes.
    if (mode === "video") {
      saveBlob(id, new Blob(blobParts, { type: "video/mp4" }), filename);
      return;
    }
    bytes = new Uint8Array(await new Blob(blobParts).arrayBuffer());
  } else {
    // No range support. Plain video → bubble up so the browser downloads it.
    if (mode === "video") throw new Error("no range support");
    // For audio/clip/gif we must have the bytes; fetch the whole file at once.
    const ab = await pausableFetch(id, async (sig) => {
      const r = await fetch(url, { credentials: "include", signal: sig });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    if (ab.byteLength > FFMPEG_MAX_BYTES) {
      throw new Error(`File is ${Math.round(ab.byteLength / 1e6)} MB — too large to ${mode} in-browser.`);
    }
    bytes = new Uint8Array(ab);
    postProgress(id, 1, 1);
  }

  // audio/clip/gif on a progressive file → run ffmpeg on the assembled bytes.
  getControl(id).converting = true;
  chrome.runtime.sendMessage({ type: "hls-phase", id, phase: "converting" });
  // Infer source container from the filename/URL so ffmpeg gets a sane demuxer.
  const srcExt = /\.webm(\?|#|$)/i.test(url) ? "webm" : "mp4";
  await emitWithMode(id, bytes, srcExt, job);
}
