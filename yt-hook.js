// Video Catch — YouTube MediaSource capture hook (MAIN world, document_start)
//
// YouTube (SABR era) has no grabbable stream URLs: HD is server-driven and even
// the 360p URL 403s without descrambling base.js. The one thing that always
// works is tapping the media AFTER the browser has fetched + decrypted it — i.e.
// the exact fMP4 bytes the player feeds the <video> via MediaSource Extensions.
//
// This runs in the page's MAIN world BEFORE the player initialises, hooks
// appendBuffer, and accumulates the video and audio byte streams. It can also
// AUTO-BUFFER: mute the video and run it at 16x so the whole thing downloads in
// seconds with no real-time watching, then auto-finalises. The isolated bridge
// (youtube.js) ships the captured tracks off to be muxed into one MP4.

(() => {
  if (window.__vcHooked) return;
  window.__vcHooked = true;

  // --- prefer MP4: make the player choose H.264 + AAC ------------------------
  // YouTube defaults to AV1/VP9 video + Opus audio, which can't stream-copy into
  // .mp4 (we fall back to .mkv). Telling the player those codecs are unsupported
  // makes it serve H.264 (avc1) + AAC instead → the capture muxes into a clean,
  // universally-playable .mp4. Tradeoff: H.264 caps at 1080p (no 4K), and it also
  // affects normal viewing on this tab — so it's a toggle (localStorage flag set by
  // youtube.js from the setting; default ON). Must run at document_start, before
  // the player negotiates codecs.
  try {
    const preferMp4 = localStorage.getItem("vc_captureMp4") !== "0"; // default ON
    if (preferMp4) {
      const REJECT = /av01|av1|vp9|vp09|vp08|vp8|opus|webm/i;
      const origIsSup = MediaSource.isTypeSupported.bind(MediaSource);
      MediaSource.isTypeSupported = (t) => (REJECT.test(t || "") ? false : origIsSup(t));
      const origCanPlay = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (t) {
        return REJECT.test(t || "") ? "" : origCanPlay.call(this, t);
      };
    }
  } catch {}

  // STREAMING CAPTURE: during a capture every fragment is shipped to the
  // extension's offscreen document THE MOMENT it's appended — the page retains
  // nothing, so tab memory stays flat no matter how long the video is (the old
  // in-page hold truncated a 53-min capture at ~35min when it hit the byte cap).
  // Before a capture starts we passively RETAIN a small window (so an already-
  // buffered short video still captures instantly), bounded by PASSIVE_CAP.
  const PASSIVE_CAP = 200 * 1024 * 1024;
  // Sanity ceiling on a single capture (disk-backed on the other side).
  const HARD_CAP = 8 * 1024 * 1024 * 1024;
  const RATE = 8; // auto-buffer playback speed — the tested sweet spot. 16x outran
  // the fetch (skipped segments → frozen stretches); 8x captures a full 9:56 video
  // cleanly and keeps the feature fast. Don't go higher. The rare failed/glitchy
  // capture is handled by the Re-capture/Retry button rather than by slowing
  // everyone down. Window-confinement (inCaptureWindow) bounds range clips so they
  // don't balloon even at 8x.
  const state = {
    // `armed` is true from page load so we ALWAYS retain media the player buffers
    // — even before the user clicks Capture. Otherwise a short video that's
    // already fully buffered when you click Capture ships nothing (the auto-buffer
    // finds it all buffered and triggers no new appendBuffer calls). We reset the
    // accumulation per-video on SPA navigation (youtube.js sends "reset").
    armed: true,
    capturing: false, // an auto-buffer session is running
    captureId: null,
    tracks: new Map(), // SourceBuffer -> { id, kind, mime, init, retained, bytes }
    total: 0,
    retainedBytes: 0, // pre-capture passively retained bytes (bounded by PASSIVE_CAP)
    overflow: false,
    skipAds: true, // don't record YouTube ads into the captured file
    paused: false, // user paused the capture — hold the auto-buffer (keep the video paused)
    covered: [], // union of every buffered range we've seen = our captured coverage
    // Range capture: buffer only [rangeStart, rangeEnd] instead of the whole video.
    // 0/0 = full video. The offscreen muxer trims to exactly this window; we just
    // need to make the player fetch it (plus a lead-in for the keyframe).
    rangeStart: 0,
    rangeEnd: 0,
    contentDur: 0, // the real video's duration, captured before any ad plays
  };

  // Where this capture must start buffering. We rewind a few seconds before the
  // requested start so the copy-cut lands on a keyframe at/just before it (YouTube
  // GOPs run ~2-5s); the muxer's -ss then trims the lead-in off precisely.
  const RANGE_LEAD_IN = 6;
  function capStart() {
    return state.rangeEnd > 0 ? Math.max(0, state.rangeStart - RANGE_LEAD_IN) : 0;
  }
  function capStop(dur) {
    return state.rangeEnd > 0 ? Math.min(dur, state.rangeEnd) : dur;
  }

  function kindFromMime(mime) {
    const m = (mime || "").toLowerCase();
    if (m.startsWith("audio")) return "audio";
    if (m.startsWith("video")) return "video";
    return "other";
  }

  // Is the player currently showing an ad? YouTube flags this on #movie_player.
  // While true we DON'T capture the appended bytes (they'd be the ad's video,
  // spliced into your file at a different resolution/codec — glitchy) and the
  // auto-buffer tries to skip/blow through the ad instead of buffering it.
  function isAdShowing() {
    const p = document.getElementById("movie_player");
    if (!p) return false;
    if (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting")) return true;
    // Fallback signal from the player API (getAdState() === 1 during an ad).
    try {
      if (typeof p.getAdState === "function" && p.getAdState() === 1) return true;
    } catch {}
    // DURATION MISMATCH — the most reliable signal. An ad plays through the SAME
    // <video>, so during it `duration` becomes the AD's length, not the content's.
    // The CSS classes lag by a tick or two at ad start/end; this doesn't, which
    // stops ad bytes from slipping into the capture on those boundary ticks.
    if (state.capturing && state.contentDur > 0) {
      try {
        const v = document.querySelector("video.html5-main-video") || document.querySelector("video");
        if (v && isFinite(v.duration) && v.duration > 0 && Math.abs(v.duration - state.contentDur) > 1.5) return true;
      } catch {}
    }
    return false;
  }

  // Click the real "Skip" button as soon as YouTube offers it. YouTube forces
  // ads to play at 1x (you can't fast-forward them), so the ONLY way to actually
  // skip is the button — which appears a few seconds in for skippable ads. We
  // check known selectors, then fall back to any button/element that reads "skip".
  // Unskippable ads just play out (muted); their bytes are dropped either way.
  function skipAd(v) {
    try {
      if (v) v.muted = true; // silence the ad while it's up
      const player = document.getElementById("movie_player") || document;
      let btn = player.querySelector(
        ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, " +
          ".ytp-ad-skip-button-container button, .ytp-ad-skip-button-slot button, .ytp-skip-ad-button__text"
      );
      if (!btn) {
        const cands = player.querySelectorAll(
          "button, [role='button'], [class*='skip'], [class*='Skip']"
        );
        for (const b of cands) {
          const cls = String(b.className || "").toLowerCase();
          const txt = (b.textContent || "").trim().toLowerCase();
          const al = ((b.getAttribute && b.getAttribute("aria-label")) || "").toLowerCase();
          if ((/skip/.test(cls) && /button|slot/.test(cls)) || /^skip(\b| ad)/.test(txt) || /skip.*ad/.test(al)) {
            btn = b;
            break;
          }
        }
      }
      if (btn) {
        btn.click();
        // Some skip buttons need the click on the container element.
        if (btn.parentElement && btn.parentElement.click) btn.parentElement.click();
      }
      // Fast-forward the ad itself. YouTube blocks playbackRate changes on ads,
      // but jumping currentTime to the ad's end usually terminates it right away
      // — this is what actually clears UNSKIPPABLE ads (and skippable ones before
      // their 5s timer), instead of waiting them out while buffering stalls.
      // Guarded by a short duration so we can never do this to real content.
      if (v && isFinite(v.duration) && v.duration > 0 && v.duration < 300) {
        try {
          if (v.currentTime < v.duration - 0.15) v.currentTime = v.duration - 0.1;
        } catch {}
      }
    } catch {}
  }

  // An init segment starts with ftyp/moov (codec config). We must keep it even
  // when not actively capturing, or the muxed file has no decoder config.
  function isInit(u8) {
    if (!u8 || u8.byteLength < 8) return false;
    const t = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
    return t === "ftyp" || t === "moov";
  }

  // A brand-new MediaSource = a new video/stream load (YouTube's SPA makes one
  // per video). That's the precise "fresh video" signal — reset accumulation then
  // so we never mix two videos, and without the timing risk of clipping the new
  // video's first segment (which a navigation-event timer would have). A quality
  // change reuses the SAME MediaSource, so it won't trigger a reset.
  const seenMediaSources = new WeakSet();
  const origAdd = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    try {
      if (!seenMediaSources.has(this)) {
        seenMediaSources.add(this);
        // A new MediaSource normally means a new video (SPA nav) → drop old media.
        // BUT while a capture is running, a new MediaSource is almost always an
        // AD (YouTube plays ads through a fresh MediaSource) or the ad→content
        // hand-off — NOT a new video. Resetting then wipes the content we've
        // captured (the "MB counter jumps back to zero" bug) and leaves a
        // truncated/empty track that makes the mux fail with an FS error. So we
        // never reset during an active capture; the ad's bytes land in its own
        // small SourceBuffers and are ignored (we pick the largest track per kind).
        if (!state.capturing) {
          if (state.tracks.size || state.total) {
            state.tracks.clear();
            state.total = 0;
            state.retainedBytes = 0;
            state.overflow = false;
          }
          state.armed = true; // a fresh video — start retaining its media again
          finalized = false;
        }
      }
    } catch {}
    const sb = origAdd.call(this, mime);
    try {
      state.tracks.set(sb, mkTrackRec(kindFromMime(mime), mime));
    } catch {}
    return sb;
  };

  const origAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      let rec = state.tracks.get(this);
      if (!rec) {
        rec = mkTrackRec("other", "");
        state.tracks.set(this, rec);
      }
      const u8 =
        data instanceof Uint8Array
          ? new Uint8Array(data)
          : data instanceof ArrayBuffer
          ? new Uint8Array(data.slice(0))
          : data && data.buffer
          ? new Uint8Array(data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + data.byteLength))
          : null;
      // Skip everything the player appends while an ad is on screen — including
      // the ad's own init segment, which would otherwise overwrite the real
      // video's codec config. (Passive too: we never want ad bytes retained.)
      const adBlocked = state.skipAds && isAdShowing();
      if (u8 && u8.byteLength && !adBlocked) {
        if (isInit(u8)) {
          rec.init = u8; // always keep latest codec config
          if (state.capturing) shipInit(rec);
        } else if (state.armed && !state.overflow && inCaptureWindow(rec, u8)) {
          if (state.capturing) {
            // STREAM it out now — the page never accumulates capture data.
            shipChunk(rec, u8);
          } else {
            // Pre-capture: retain a bounded window so an already-buffered short
            // video can still be captured instantly.
            rec.retained.push(u8);
            state.retainedBytes += u8.byteLength;
            if (state.retainedBytes > PASSIVE_CAP) dropRetained();
          }
          rec.bytes += u8.byteLength;
          state.total += u8.byteLength;
          if (state.total > HARD_CAP) {
            state.overflow = true;
            post({ evt: "overflow" });
          }
        }
      }
    } catch {}
    return origAppend.apply(this, arguments);
  };

  // --- tap the player's OWN timedtext (caption) requests ---------------------
  // YouTube returns an EMPTY body unless the timedtext request carries the
  // player's proof-of-origin token (`pot`) — which we can't generate. But the
  // player itself makes authenticated timedtext requests whenever captions are
  // on, and those URLs include the valid token. We tap them here and later reuse
  // the URL (swapping in the wanted lang/format) to fetch real cues.
  const subUrlByKey = new Map(); // lang|kind|tlang -> player request URL (has pot)
  const subRespByKey = new Map(); // lang|kind|tlang -> { text, fmt } captured body
  let lastTimedtextUrl = null;
  function keyOf(u) {
    const lang = u.searchParams.get("lang") || "";
    const asr = u.searchParams.get("kind") === "asr" ? "asr" : "";
    const tl = u.searchParams.get("tlang") || "";
    return { full: lang + "|" + asr + "|" + tl, loose: lang + "|" + asr };
  }
  function noteTimedtext(rawUrl) {
    try {
      if (!rawUrl) return;
      const href = String(rawUrl);
      if (!/\/api\/timedtext/.test(href)) return;
      const u = new URL(href, location.href);
      lastTimedtextUrl = u.href;
      const k = keyOf(u);
      subUrlByKey.set(k.full, u.href);
      subUrlByKey.set(k.loose, u.href);
    } catch {}
  }
  // Capture the player's caption RESPONSE bytes — the bulletproof path (no token
  // or signature juggling; it's exactly what the player received).
  function noteSubResponse(rawUrl, text) {
    try {
      if (!text || !text.trim() || !/\/api\/timedtext/.test(String(rawUrl))) return;
      const u = new URL(String(rawUrl), location.href);
      const rec = { text, fmt: u.searchParams.get("fmt") || "srv3" };
      const k = keyOf(u);
      subRespByKey.set(k.full, rec);
      subRespByKey.set(k.loose, rec);
    } catch {}
  }
  try {
    const of = window.fetch;
    if (of && !of.__vcSub) {
      window.fetch = function (...a) {
        const u = a[0] && a[0].url ? a[0].url : a[0];
        try {
          noteTimedtext(u);
        } catch {}
        const p = of.apply(this, a);
        try {
          if (u && /\/api\/timedtext/.test(String(u))) {
            p.then((res) => {
              try {
                res.clone().text().then((t) => noteSubResponse(u, t)).catch(() => {});
              } catch {}
            }).catch(() => {});
          }
        } catch {}
        return p;
      };
      window.fetch.__vcSub = true;
    }
  } catch {}
  try {
    const oo = XMLHttpRequest.prototype.open;
    const os = XMLHttpRequest.prototype.send;
    if (oo && !oo.__vcSub) {
      XMLHttpRequest.prototype.open = function (m, url) {
        try {
          this.__vcTT = url && /\/api\/timedtext/.test(String(url)) ? String(url) : null;
          noteTimedtext(url);
        } catch {}
        return oo.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        try {
          if (this.__vcTT) {
            this.addEventListener("load", () => {
              try {
                noteSubResponse(this.__vcTT, this.responseText);
              } catch {}
            });
          }
        } catch {}
        return os.apply(this, arguments);
      };
      XMLHttpRequest.prototype.open.__vcSub = true;
    }
  } catch {}

  function post(msg) {
    window.postMessage({ source: "vc-evt", captureId: state.captureId, ...msg }, "*");
  }

  function summary() {
    const byKind = {};
    for (const rec of state.tracks.values()) {
      const k = rec.kind;
      if (!byKind[k] || rec.bytes > byKind[k].bytes) byKind[k] = rec;
    }
    return {
      capturing: state.capturing,
      overflow: state.overflow,
      video: byKind.video ? byKind.video.bytes : 0,
      audio: byKind.audio ? byKind.audio.bytes : 0,
      other: byKind.other ? byKind.other.bytes : 0,
    };
  }

  function toB64(u8) {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }

  // --- streaming ship (page holds nothing during a capture) ------------------
  let sbSeq = 0;
  function mkTrackRec(kind, mime) {
    return { id: "t" + sbSeq++, kind, mime, init: null, retained: [], bytes: 0 };
  }

  function shipInit(rec) {
    if (!rec.init) return;
    post({ evt: "tinit", trackId: rec.id, kind: rec.kind, mime: rec.mime, b64: toB64(rec.init) });
  }

  // Ship one media fragment with its tfdt decode time (raw TICKS — the offscreen
  // side converts using the timescale it parses from the init segment).
  function shipChunk(rec, u8) {
    post({ evt: "tchunk", trackId: rec.id, kind: rec.kind, mime: rec.mime, t: decodeTimeOf(u8), b64: toB64(u8) });
  }

  // Passive retention overflowed pre-capture — drop it all. Safe: a capture that
  // needs earlier content re-fetches it (reload-from-0 / coverage steering).
  function dropRetained() {
    for (const rec of state.tracks.values()) {
      rec.retained = [];
      rec.bytes = 0;
    }
    state.retainedBytes = 0;
    state.total = 0;
  }

  // Seek via the PLAYER's own API when available — a raw video.currentTime write
  // can be overridden by YouTube's resume/deep-link (&t=) logic, which is how a
  // "capture full video" ended up starting at the user's watch position instead
  // of 0. player.seekTo() is authoritative.
  function hardSeek(v, t) {
    try {
      const p = document.getElementById("movie_player");
      if (p && typeof p.seekTo === "function") {
        p.seekTo(t, true);
        return;
      }
    } catch {}
    try {
      if (v) v.currentTime = t;
    } catch {}
  }

  // Read a fragment's decode timestamp from its `tfdt` box (baseMediaDecodeTime).
  // The player appends fragments in PLAYBACK/SEEK order, not time order — so if the
  // user scrubbed or we seek-chase, the stored order is non-monotonic and the muxed
  // video freezes / starts mid-way. tfdt lets us reassemble a clean 0→end stream.
  function decodeTimeOf(u8) {
    const limit = Math.min(u8.length - 12, 600); // tfdt lives early, inside moof
    for (let i = 0; i < limit; i++) {
      if (u8[i] === 0x74 && u8[i + 1] === 0x66 && u8[i + 2] === 0x64 && u8[i + 3] === 0x74) {
        const version = u8[i + 4];
        const p = i + 8; // 4 fourcc + 1 version + 3 flags
        if (version === 1) {
          const hi = u8[p] * 0x1000000 + (u8[p + 1] << 16) + (u8[p + 2] << 8) + u8[p + 3];
          const lo = u8[p + 4] * 0x1000000 + (u8[p + 5] << 16) + (u8[p + 6] << 8) + u8[p + 7];
          return hi * 0x100000000 + lo;
        }
        return u8[p] * 0x1000000 + (u8[p + 1] << 16) + (u8[p + 2] << 8) + u8[p + 3];
      }
    }
    return null;
  }

  // (Fragment ordering, dedup, track start / keyframe timing and A/V alignment
  // all live in the offscreen document now — computed from the shipped data
  // itself, which is ground truth. The page only tags each fragment with its raw
  // tfdt ticks via decodeTimeOf above.)

  // mdhd timescale (ticks/sec) from an init segment — to turn a fragment's tfdt
  // ticks into SECONDS so we can tell whether a fragment is inside a clip window.
  function boxTimescale(init) {
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

  // For a RANGE clip, keep ONLY fragments whose decode time falls inside the
  // window (+ lead-in/margin). This confines the capture to the clip even if the
  // player wanders back to 0 — e.g. after a pre-roll ad on the reload, which
  // otherwise made the hook grab the ENTIRE video from the start ("captured full
  // video" bug). It also stops long clips from ballooning with out-of-window
  // fragments. SAFE: if we can't determine a fragment's time (no timescale yet or
  // no tfdt), we KEEP it — confinement never drops when unsure.
  function inCaptureWindow(rec, u8) {
    if (state.rangeEnd <= 0) return true; // full capture — no window
    if (!rec.timescale) rec.timescale = rec.init ? boxTimescale(rec.init) : 0;
    if (!rec.timescale) return true;
    const t = decodeTimeOf(u8);
    if (t == null) return true;
    const sec = t / rec.timescale;
    return sec >= Math.max(0, state.rangeStart - RANGE_LEAD_IN - 3) && sec <= state.rangeEnd + 3;
  }

  // The video's real title. The player API is the reliable source (populated by
  // the time we're capturing); the DOM <h1> and document.title lag on load.
  function getTitle() {
    try {
      // Shorts: the player API title lags behind scroll (keeps the previous short's
      // name), but document.title updates to the current short — prefer it there.
      if (/^\/shorts\//.test(location.pathname)) {
        const d = (document.title || "").replace(/\s*-\s*YouTube$/, "").trim();
        if (d && d.toLowerCase() !== "youtube") return d;
      }
      const mp = document.getElementById("movie_player");
      const t = mp && mp.getVideoData && mp.getVideoData().title;
      if (t) return t;
    } catch {}
    try {
      const t = window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails && window.ytInitialPlayerResponse.videoDetails.title;
      if (t) return t;
    } catch {}
    return (document.title || "").replace(/\s*-\s*YouTube$/, "");
  }

  function findVideo() {
    const vids = [...document.querySelectorAll("video")];
    if (vids.length <= 1) return vids[0] || null;
    // Multiple <video> (Shorts stacks several) — pick the best: the main player, or
    // whichever is visible + playing + has a real duration.
    let best = null;
    let bestScore = -1;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
      const finite = isFinite(v.duration) && v.duration > 0;
      const score =
        (v.classList.contains("html5-main-video") ? 8 : 0) +
        (visible ? 4 : 0) +
        (!v.paused && v.currentTime > 0 ? 2 : 0) +
        (finite ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best || vids[0];
  }

  // --- auto-buffer: race the player through the whole video, then finalize ---
  let autoTimer = null;
  let finalized = false; // guards against finishing/shipping twice
  let reloadedForCapture = false; // did we already reload-from-0 for this capture?
  let settledForReload = false; // waited once for the player to settle before deciding to reload
  let capDur = 0; // target duration + how far we actually buffered — to flag an
  let capEnd = 0; // incomplete capture (backgrounded tab stalled) instead of "done".

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  // Fold the player's CURRENT buffered ranges into our persistent coverage union.
  // We capture fragments as they're buffered, so this union = exactly what we've
  // captured — and unlike the player's live buffer, it's never evicted. Scrubbing
  // anywhere just adds another range here; it can't remove coverage.
  function addCovered(v) {
    try {
      for (let i = 0; i < v.buffered.length; i++) {
        state.covered.push([v.buffered.start(i), v.buffered.end(i)]);
      }
    } catch {}
    if (!state.covered.length) return;
    state.covered.sort((a, b) => a[0] - b[0]);
    const merged = [state.covered[0].slice()];
    for (let i = 1; i < state.covered.length; i++) {
      const r = state.covered[i];
      const last = merged[merged.length - 1];
      if (r[0] <= last[1] + 0.5) last[1] = Math.max(last[1], r[1]); // touching/overlapping → merge
      else merged.push(r.slice());
    }
    state.covered = merged;
  }

  // How much we have CONTIGUOUSLY from the capture's start point — the true
  // completion metric. For a full capture that's from 0; for a range capture it's
  // from capStart(), so coverage before the window doesn't count as progress.
  function coveredEndOf(ranges, from = 0) {
    let end = from;
    for (const r of ranges) {
      if (r[1] < from) continue; // entirely before the window — ignore
      if (r[0] <= end + 0.5) end = Math.max(end, r[1]);
      else break; // a gap — contiguous coverage stops here
    }
    return end;
  }

  // The current video's id — so a capture can tell if the user navigated away.
  function vidId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === "/watch") return u.searchParams.get("v") || "";
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
      return m ? m[1] : u.pathname;
    } catch {
      return location.pathname;
    }
  }

  // Drive the *buffered frontier* to the end of the video. CRITICAL for capture
  // integrity: we only ever seek TO the current buffered frontier (and wait for it
  // to advance) — never PAST it. Jumping past unbuffered regions aborts the
  // in-flight video segment fetch, so that segment is never appended → a gap. With
  // audio buffering fine, the muxed video then has fewer frames than the audio and
  // appears to "speed up"/jump. Seeking only to the frontier keeps the fetch
  // contiguous, so every video segment is captured in order.
  let savedPos = 0;
  let savedMuted = false;
  function startAutoBuffer(attempt, adWaits) {
    if (autoTimer) return; // a capture is already running — don't start a second
    const v = findVideo();
    // NEVER start while an ad is on screen: `v.duration` would be the AD's length,
    // which we'd then treat as the video's length (capture ends after a few
    // seconds) and use as the ad-detection baseline. Skip it and wait for content.
    if (isAdShowing()) {
      skipAd(v);
      if ((adWaits || 0) < 90) {
        post({ evt: "status", ...summary(), pct: 0, ad: true });
        setTimeout(() => startAutoBuffer(attempt, (adWaits || 0) + 1), 500);
        return;
      }
    }
    // The duration loads a beat late (esp. on Shorts) — wait up to ~4s before giving
    // up, instead of failing instantly with "Live/unknown length".
    if (!v || !isFinite(v.duration) || v.duration <= 0) {
      if ((attempt || 0) < 8) {
        setTimeout(() => startAutoBuffer((attempt || 0) + 1, adWaits), 500);
        return;
      }
      return post({ evt: "error", reason: "Live or unknown length — can't auto-capture." });
    }
    const dur = v.duration;
    // Baseline for duration-based ad detection (see isAdShowing). Recorded here,
    // after the ad guard above, so it's always the CONTENT's duration.
    state.contentDur = dur;

    // CLEAN RELOAD FROM 0. If the player isn't already at the very start — you've
    // watched into it, or it's a "&t=23s" deep link — reload the video from second 0
    // via YouTube's own player API. This gives one fresh, single-quality stream from
    // the exact beginning, instead of inheriting a partial / wrong-position /
    // mixed-quality buffer (the cause of "starts at 23s", frozen frames, and audio
    // desync). We only do this when needed, so a video opened fresh at 0 isn't
    // reloaded (and doesn't replay a pre-roll ad unnecessarily).
    // Skip the reload for Shorts — they already play from 0, have their own player,
    // and reloading them causes a buffer loop.
    const isShorts = /^\/shorts\//i.test(location.pathname);
    const isRange = state.rangeEnd > 0;
    // Where a clean reload should land: 0 for a full capture; the window's lead-in
    // for a range clip. loadVideoById to this point re-fetches ONE clean
    // single-quality stream and discards whatever was cached/buffered from prior
    // watching — the "clear the already-watched portion and re-capture" the user
    // asked for.
    const targetStart = isRange ? Math.max(0, capStart()) : 0;

    // BEAT THE RESUME RACE. If you've watched this video before, YouTube restores
    // your last position + has cached/mid-video segments buffered — but that
    // resume is applied a beat AFTER load. Reading currentTime immediately saw 0,
    // so the reload guard never fired and the capture inherited a scrambled,
    // partial, mid-video buffer → the muxer failed ("works on a fresh video,
    // always breaks on one I've watched"). Wait once so the player settles, THEN
    // decide — on a fresh video this just costs ~0.7s.
    if (!reloadedForCapture && !isShorts && !settledForReload) {
      settledForReload = true;
      setTimeout(() => startAutoBuffer(0), 700);
      return;
    }

    // Decide whether to reload for a clean, uncontaminated stream:
    //  - RANGE clip: ALWAYS. The window sits mid-video, exactly where a
    //    previously-watched video has cached/scrambled segments; a plain seek
    //    there inherits that mess. Reloading the player straight to the window
    //    start re-fetches it clean. (This is the case that was still broken in
    //    2.27.2 — the reload was gated to full captures only.)
    //  - FULL capture: only if it's NOT a clean run from 0 (keeps the fast,
    //    reload-free path for a genuinely fresh video, which already works).
    let needReload = false;
    try {
      const bufStart = v.buffered && v.buffered.length ? v.buffered.start(0) : 0;
      needReload = isRange || v.currentTime > 3 || bufStart > 1.5;
      console.log(`[VideoCatch][yt-hook] pre-capture: range=${isRange} target=${targetStart.toFixed(1)} t=${(v.currentTime||0).toFixed(1)} bufStart=${bufStart.toFixed(1)} needReload=${needReload} reloaded=${reloadedForCapture}`);
    } catch {}
    if (!reloadedForCapture && !isShorts && needReload) {
      const player = document.getElementById("movie_player");
      const id = vidId();
      if (player && typeof player.loadVideoById === "function" && id && id.length >= 6) {
        reloadedForCapture = true;
        state.tracks.clear(); // drop the stale mid-watch fragments; capture fresh
        state.total = 0;
        state.retainedBytes = 0;
        state.overflow = false;
        state.covered = [];
        state.armed = true;
        // Anything already streamed to the offscreen store is stale — wipe it so
        // the fresh stream starts clean.
        post({ evt: "wipe" });
        console.log(`[VideoCatch][yt-hook] reloading to ${targetStart.toFixed(1)}s for a clean capture`);
        try {
          player.loadVideoById({ videoId: id, startSeconds: Math.floor(targetStart) });
        } catch {}
        // Belt-and-braces: the deep-link/resume logic can override the reload's
        // start position — force the playhead to the target via the player API.
        setTimeout(() => hardSeek(findVideo(), targetStart), 1200);
        // Let the reloaded stream initialise, then start the capture.
        setTimeout(() => startAutoBuffer(0), 1600);
        return;
      }
    }

    // Every captured fragment carries its decode timestamp; the offscreen muxer
    // reassembles by time, so residual out-of-order bits are handled there.
    savedPos = v.currentTime || 0; // restore the user's position when done
    savedMuted = v.muted; // we mute for auto-buffer; restore the user's setting
    // Lock the quality for the whole capture. Otherwise fast-forwarding (esp. in a
    // backgrounded tab) makes YouTube drop resolution mid-stream, which emits a new
    // init segment — the captured file then mixes resolutions and the decoder
    // glitches/"jumps" at the switch. Pin to the current quality so it stays one
    // consistent stream. (Set your desired quality before capturing.)
    try {
      const player = document.getElementById("movie_player");
      if (player && player.getAvailableQualityLevels && player.setPlaybackQualityRange) {
        const levels = player.getAvailableQualityLevels() || [];
        const cur = player.getPlaybackQuality ? player.getPlaybackQuality() : null;
        // current quality if known, else the best available (excluding "auto")
        const pick = cur && cur !== "auto" && cur !== "unknown"
          ? cur
          : levels.find((q) => q !== "auto");
        if (pick) player.setPlaybackQualityRange(pick, pick);
      }
    } catch {}
    const drive = () => {
      try {
        v.muted = true;
        v.playbackRate = RATE;
      } catch {}
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    };
    const captureVid = vidId(); // which video this capture belongs to
    state.covered = []; // start this capture's coverage fresh
    const from = capStart(); // 0 for a full capture; window lead-in for a range
    const stopAt = capStop(dur); // dur for a full capture; window end for a range
    hardSeek(v, from); // begin filling at the capture's start point (player API — see hardSeek)
    drive();

    let lastCEnd = -1;
    let noGrow = 0;
    let lastPct = 0;
    autoTimer = setInterval(() => {
      // Paused by the user → keep the video paused (re-assert each tick in case the
      // player auto-resumes) so it stops fetching. A "resume" clears the flag and the
      // coverage-driven loop simply picks up filling from wherever the hole is.
      if (state.paused) {
        try {
          v.pause();
          v.playbackRate = 1;
        } catch {}
        return;
      }

      // User navigated to a DIFFERENT video mid-capture → finish this one and stop.
      if (vidId() !== captureVid || !v.isConnected) return finishAuto();

      // An ad is playing: don't measure/steer — `v.buffered` and `v.duration`
      // describe the AD, so folding them into our coverage would record phantom
      // progress (and, at 0-based ad time, fake coverage at the video's start).
      // NOTE: this guard is intentionally NOT gated on the skipAds setting —
      // measuring during an ad is always wrong; only the skipping is optional.
      if (isAdShowing()) {
        if (state.skipAds) skipAd(v);
        post({ evt: "status", ...summary(), pct: lastPct, ad: true });
        return;
      }

      // COVERAGE-DRIVEN CAPTURE (immune to slider sabotage). Fold the player's current
      // buffered ranges into our persistent coverage, then measure how much we have
      // CONTIGUOUSLY from 0. Scrubbing anywhere only adds ranges — it can't create a
      // hole we won't fill.
      addCovered(v);
      const cEnd = coveredEndOf(state.covered, from);
      capEnd = cEnd;
      capDur = stopAt;
      // Progress is measured across the capture WINDOW (from → stopAt), so a range
      // capture shows 0→100% for its own clip, not a sliver of the full video.
      const span = Math.max(0.1, stopAt - from);
      lastPct = Math.min(99, Math.round(((cEnd - from) / span) * 100));
      post({ evt: "status", ...summary(), pct: lastPct });

      // DONE when contiguous coverage reaches the capture window's end.
      if (state.overflow || cEnd >= stopAt - 1) return finishAuto();

      drive();

      // If contiguous coverage isn't GROWING, the playhead is off elsewhere (you
      // scrubbed) or stalled — steer it to the coverage edge so the player fetches the
      // NEXT missing segment, in order. Whatever you do with the slider, we keep
      // filling the hole from 0 forward until the video is complete.
      if (cEnd <= lastCEnd + 0.05) {
        noGrow++;
        if (noGrow % 2 === 0) {
          hardSeek(v, Math.min(stopAt - 0.1, Math.max(from, cEnd)));
        }
        if (noGrow > 160) return finishAuto(); // ~80s with zero coverage growth → keep what we got
      } else {
        noGrow = 0;
      }
      lastCEnd = cEnd;
    }, 500);
  }

  // Restore the player to the user's state: normal speed, original mute, paused at
  // where they were. Used both when capture finishes and when it's canceled.
  function restoreVideo() {
    const v = findVideo();
    try {
      if (v) {
        v.playbackRate = 1;
        v.muted = savedMuted;
        v.pause();
        if (savedPos > 0 && isFinite(savedPos)) v.currentTime = savedPos;
      }
    } catch {}
  }

  function finishAuto() {
    if (finalized) return; // don't re-ship if called twice (tick + end + finalize)
    finalized = true;
    stopAuto();
    state.capturing = false;
    // Stop passively accumulating once this video's capture is done — otherwise the
    // hook keeps appending bytes as the (now-finished) video plays on, so the MB
    // counter keeps climbing and a fresh capture would build on top of stale bytes.
    // A new video (new MediaSource) re-arms us below.
    state.armed = false;
    const dur = (findVideo() || {}).duration || 0;
    // Incomplete = we buffered noticeably less than the video's length (the tab got
    // backgrounded / app switched, so YouTube stopped fetching). Tell the user so a
    // short file isn't reported as a clean success.
    // Measure completeness across the capture WINDOW (range captures start > 0).
    const from = capStart();
    const span = capDur - from;
    const got = capEnd - from;
    const incomplete = span > 5 && got > 0 && got < span - 3 && got < span * 0.95;
    state.contentDur = 0; // clear the ad-detection baseline for the next capture
    restoreVideo();
    // All media already streamed to the offscreen store live — the done event
    // just carries metadata; ordering/alignment/trim are computed over there.
    post({ evt: "finalizing", ...summary(), title: getTitle() });
    post({
      evt: "done",
      title: getTitle(),
      duration: dur,
      incomplete,
      buffered: Math.round(Math.max(0, got)),
      total: Math.round(Math.max(0, span)),
      rangeStart: state.rangeStart,
      rangeEnd: state.rangeEnd,
    });
  }

  function resetMedia() {
    for (const rec of state.tracks.values()) {
      rec.retained = [];
      rec.bytes = 0;
    }
    state.total = 0;
    state.retainedBytes = 0;
    state.overflow = false;
  }

  // --- subtitles: fetch captions FROM THE PAGE (same origin/session as the
  // player) -----------------------------------------------------------------
  // YouTube returns an EMPTY body when timedtext is fetched from the extension's
  // service worker (it's gated to the player's own context). Fetching from here —
  // the page's MAIN world — is indistinguishable from the player's request, so we
  // get the real cues. We read the freshest caption list straight off the live
  // player (`getPlayerResponse`), falling back to `ytInitialPlayerResponse`.
  function liveCaptionTracks() {
    try {
      const p = document.getElementById("movie_player");
      const r = p && p.getPlayerResponse && p.getPlayerResponse();
      let tracks = r && r.captions && r.captions.playerCaptionsTracklistRenderer
        && r.captions.playerCaptionsTracklistRenderer.captionTracks;
      if ((!tracks || !tracks.length) && window.ytInitialPlayerResponse) {
        const c = window.ytInitialPlayerResponse.captions;
        tracks = c && c.playerCaptionsTracklistRenderer && c.playerCaptionsTracklistRenderer.captionTracks;
      }
      return tracks || [];
    } catch {
      return [];
    }
  }

  function pickCaption(tracks, lang, kind) {
    const wantAuto = kind === "auto";
    return (
      tracks.find((t) => t.languageCode === lang && (t.kind === "asr") === wantAuto) ||
      tracks.find((t) => t.languageCode === lang) ||
      tracks[0] ||
      null
    );
  }

  // Turn captions ON via the player API so the player fetches the timedtext (which
  // our hook taps) — otherwise, with CC off, we have no token'd URL and the fetch
  // comes back empty ("caption returned empty"). Waits briefly for the tap to land.
  async function ensureCaptions(d) {
    try {
      const p = document.getElementById("movie_player");
      if (!p || !p.setOption) return;
      try {
        if (p.loadModule) p.loadModule("captions");
      } catch {}
      const track = {};
      if (d.lang) track.languageCode = d.lang;
      if (d.kind === "auto") track.kind = "asr";
      try {
        p.setOption("captions", "track", track);
      } catch {}
      const wantAsr = d.kind === "auto" ? "asr" : "";
      const full = d.lang + "|" + wantAsr + "|" + (d.tlang || "");
      const loose = d.lang + "|" + wantAsr;
      for (let i = 0; i < 12; i++) {
        if (subRespByKey.get(full) || subRespByKey.get(loose) || subUrlByKey.get(full) || subUrlByKey.get(loose) || lastTimedtextUrl) return;
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch {}
  }

  async function fetchSubs(d) {
    try {
      const wantAsr = d.kind === "auto" ? "asr" : "";
      const full = d.lang + "|" + wantAsr + "|" + (d.tlang || "");
      const loose = d.lang + "|" + wantAsr;

      // If we haven't seen the player fetch this track yet, turn CC on to make it.
      if (!(subRespByKey.get(full) || subRespByKey.get(loose) || subUrlByKey.get(full) || subUrlByKey.get(loose))) {
        await ensureCaptions(d);
      }

      // 1) BEST: a caption RESPONSE the player already fetched (exact bytes, any
      // format) — no token/signature concerns at all.
      const rec = subRespByKey.get(full) || (d.tlang ? null : subRespByKey.get(loose));
      if (rec && rec.text && rec.text.trim()) {
        return post({ evt: "subsresult", reqId: d.reqId, ok: true, text: rec.text, fmt: rec.fmt });
      }

      // 2) Reuse a timedtext URL the player fetched (carries the valid pot); swap
      // in the wanted lang/kind/tlang + fmt=vtt.
      let url = null;
      const base = subUrlByKey.get(full) || subUrlByKey.get(loose) || lastTimedtextUrl;
      if (base) {
        const u = new URL(base, location.href);
        if (d.lang) u.searchParams.set("lang", d.lang);
        if (wantAsr) u.searchParams.set("kind", "asr");
        else u.searchParams.delete("kind");
        if (d.tlang) u.searchParams.set("tlang", d.tlang);
        else u.searchParams.delete("tlang");
        u.searchParams.delete("name");
        u.searchParams.set("fmt", "vtt");
        url = u.href;
      } else {
        // 3) Last resort: the live player's baseUrl (no pot — may come back empty).
        const t = pickCaption(liveCaptionTracks(), d.lang, d.kind);
        const b = (t && t.baseUrl) || d.url;
        if (!b) return post({ evt: "subsresult", reqId: d.reqId, ok: false, error: "no-track" });
        url = b + (b.includes("?") ? "&" : "?") + "fmt=vtt" + (d.tlang ? "&tlang=" + encodeURIComponent(d.tlang) : "");
      }
      const res = await fetch(url, { credentials: "include" });
      const text = await res.text();
      post({ evt: "subsresult", reqId: d.reqId, ok: !!(text && text.trim()), text: text || "", fmt: "vtt" });
    } catch (e) {
      post({ evt: "subsresult", reqId: d.reqId, ok: false, error: String((e && e.message) || e) });
    }
  }

  window.addEventListener("message", (e) => {
    // Only accept commands posted by THIS window (the isolated-world bridge) —
    // blocks forged commands from embedded iframes / other windows.
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "vc-cmd") return;
    if (d.cmd === "start") {
      state.captureId = d.captureId || null;
      if (typeof d.skipAds === "boolean") state.skipAds = d.skipAds;
      // Range capture window (seconds). Validated against the real duration below.
      const rs = Number(d.rangeStart) || 0;
      const re = Number(d.rangeEnd) || 0;
      state.rangeStart = re > rs && rs >= 0 ? rs : 0;
      state.rangeEnd = re > rs ? re : 0;
      if (state.rangeEnd > 0) {
        const vd = (findVideo() || {}).duration;
        if (isFinite(vd) && vd > 0) {
          if (state.rangeStart >= vd) {
            state.rangeStart = 0;
            state.rangeEnd = 0;
            return post({ evt: "error", reason: "Start time is past the end of the video." });
          }
          state.rangeEnd = Math.min(state.rangeEnd, vd);
        }
        // A range capture must start from a clean slate — otherwise fragments from
        // earlier passive buffering (elsewhere in the video) get shipped too.
        resetMedia();
        state.covered = [];
      }
      finalized = false;
      reloadedForCapture = false;
      settledForReload = false;
      state.armed = true;
      state.capturing = true;
      state.paused = false;
      // Flush the passively-retained window to the offscreen store first (kept
      // for THIS video since page load — how an already-buffered short video
      // captures instantly), then everything else streams live as it's appended.
      for (const rec of state.tracks.values()) {
        if (!rec.init && !rec.retained.length) continue;
        shipInit(rec);
        for (const u8 of rec.retained) shipChunk(rec, u8);
        rec.retained = [];
      }
      state.retainedBytes = 0;
      post({ evt: "started", title: getTitle() });
      if (d.auto) startAutoBuffer();
    } else if (d.cmd === "pause") {
      state.paused = true;
      try {
        const v = findVideo();
        if (v) v.pause();
      } catch {}
    } else if (d.cmd === "resume") {
      state.paused = false;
      // Nothing to restore — the coverage-driven loop automatically steers back to
      // the hole in our coverage, so scrubbing during the pause is irrelevant.
      try {
        const v = findVideo();
        if (v) {
          v.muted = true;
          v.playbackRate = RATE;
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
        }
      } catch {}
    } else if (d.cmd === "fetchsubs") {
      fetchSubs(d);
    } else if (d.cmd === "reset") {
      // New video loaded (SPA navigation) — drop the previous video's media.
      resetMedia();
    } else if (d.cmd === "stop") {
      stopAuto();
      state.capturing = false;
      state.contentDur = 0;
      restoreVideo(); // cancel: stop fast-forwarding and put the player back
      post({ evt: "stopped" });
    } else if (d.cmd === "status") {
      post({ evt: "status", ...summary() });
    } else if (d.cmd === "finalize") {
      state.captureId = d.captureId || state.captureId;
      stopAuto();
      state.capturing = false;
      state.contentDur = 0;
      post({ evt: "finalizing", ...summary(), title: getTitle() });
      post({
        evt: "done",
        title: getTitle(),
        duration: (findVideo() || {}).duration || 0,
        rangeStart: state.rangeStart,
        rangeEnd: state.rangeEnd,
      });
    }
  });

  post({ evt: "ready" });
})();
