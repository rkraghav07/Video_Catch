# Video Catch — Session Notes (2026-06-25)

Handoff so we can resume instantly after the laptop restart. (Claude's persistent
memory also has all of this — file: `project_video_catch.md`.)

## v2.28.0 — Re-capture/Retry button + Reload-page button; keep 8x (2026-07-25)
User feedback: full 9:56 capture works flawlessly at 8x → DON'T slow it down
(reverted RATE 5→8; the rare glitchy capture is handled by a retry button, not by
penalizing everyone). Two requested features:
- **Retry / Re-capture**: YouTube capture records now carry `ytReq {tabId,
  rangeStart, rangeEnd}`. Downloads tab shows "Retry" on a failed/canceled YouTube
  capture and "Re-capture" on a completed one (output only reveals itself as
  glitchy on playback). New bg `yt-recapture` handler removes the old row and
  re-runs ytCapture with the same params (needs the tab still on that video).
- **Reload page**: the existing "Refresh" only re-scans content scripts; it can't
  see a video whose network requests fired BEFORE the extension attached. New
  "↻ Reload page" (footer link + a button in the empty state) does a real
  chrome.tabs.reload so the sniffer replays the requests. No new permission
  (host <all_urls> covers tabs.reload).
Kept from 2.27.4: inCaptureWindow (range-clip window confinement) + boxTimescale.
Suite 157/157.

## v2.27.4 — Window-confined range capture + slower buffer (2026-07-25)
2.27.3 made range clips reliable EXCEPT: (a) a pre-roll ad on the reload → player
restarts at 0, hook grabbed the WHOLE video ("captured full video from beginning";
user confirmed no-ad = perfect, ad = this bug); (b) long clips (~4 min) → gaps /
stuck frames / 52MB→2MB garbage (8x fast-forward outran the fetch; frag counts
1800+ for ~240s = massive over-fetch/overlap).
Fixes (yt-hook):
- `inCaptureWindow(rec,u8)`: for a RANGE clip, keep ONLY fragments whose tfdt
  decode-time (÷ mdhd timescale, new `boxTimescale`) is inside
  [rangeStart-LEAD-3, rangeEnd+3]. Confines the capture to the clip even if the
  player wanders to 0 post-ad, and stops long-clip fragment bloat. SAFE: keeps the
  fragment whenever timescale/tfdt is unknown (never drops when unsure). Full
  captures unaffected (rangeEnd<=0 → always true).
- RATE 8 → 5: slower fast-forward so YouTube fetches every segment on long spans
  (fewer gaps/frozen frames). Captures take a bit longer.
Verified boxTimescale + in-window math on synthetic boxes. UNVERIFIED LIVE.
Status: full captures + SHORT watched-video clips confirmed working by user;
this targets the ad-path + long-clip cases. YouTube capture remains the fragile,
policy-risky feature — reliable core is elsewhere.

## v2.27.3 — Extend the watched-video reload to RANGE clips (2026-07-25)
2.27.2 fixed watched-video FULL captures but the reload was gated to
`state.rangeEnd <= 0` — so a RANGE clip on a watched video (the user's actual
case: `[yt-mux] range=485-576`) still inherited cached/scrambled mid-video
buffer → no correct output. User's own suggestion: clear the watched portion and
re-capture from scratch. Fix: reload logic now handles both — `targetStart` = 0
for full, `capStart()` (window lead-in) for range; RANGE clips ALWAYS reload via
`loadVideoById({startSeconds: targetStart})` (the window sits exactly where the
stale buffer is), FULL still only reloads when not a clean run from 0. Settle
race-beat now applies to both. Wipe + state clear before reload as before.
UNVERIFIED LIVE — user testing from the unpacked folder.
NOTE: this fixes CONTAMINATION (garbage/no-output). If a clean clip then still has
a small A/V offset, that's the separate stream-copy issue → next lever is the
re-encode-with-accurate-seek clip path (not done yet).
IMPORTANT reality check logged this session: Physics Wallah = Widevine DRM =
CANNOT be downloaded. The "market to PW students" wedge in MARKETING-PLAN.md is
INVALID; student angle only works for NON-DRM (plain HLS/DASH) platforms.

## v2.27.2 — Fix capture of PREVIOUSLY-WATCHED videos (2026-07-25)
GOLDEN repro from user: a NEVER-watched video captures perfectly every time; a
video watched even slightly ALWAYS fails (no clean file). Cause: YouTube restores
your last position + has cached mid-video segments when you reopen a watched
video, and that resume is applied a beat AFTER load. startAutoBuffer read
currentTime immediately = 0, so the reload-from-0 guard (`v.currentTime > 3`)
never fired → the capture inherited a scrambled, partial, mid-video buffer →
every mux attempt failed. Fix (yt-hook): (1) a one-time ~700ms SETTLE before the
reload decision so the restored position/buffer is visible (costs ~0.7s on fresh
videos); (2) broaden the trigger to `currentTime > 3 OR buffered.start(0) > 1.5`
(catches restored position AND a buffer that begins mid-video); (3) console
`[yt-hook] pre-capture:` + `reloading from 0` logs so any residual case is
diagnosable. loadVideoById then gives the same pristine from-0 single-quality
stream that already works 100% on fresh videos. New flag settledForReload, reset
on start. UNVERIFIED LIVE — but user has an exact repro to confirm.

## v2.27.1 — Fix header "no videos yet" while a result is shown (2026-07-24)
The header count (`#count`) only counted page-DETECTED media (`#list`), but
"paste a link" / Instagram+X auto-resolve results go into a SEPARATE list
(`#pasteResults`) — so a resolved video showed a card while the header still said
"no videos yet". New `updateHeaderCount()` counts `.card` in BOTH lists; called
from render(), both paste-populate paths, and on clear. Clear button now also
wipes pasteResults + message. Cosmetic only.

## v2.27.0 — X / Twitter: per-video Catch + real names + desc length fix (2026-07-24)
User on x.com: Catch button grabbed the WRONG video, and every stream showed the
page title "(2) Home / X". Same feed-level problem we solved for IG/Reddit.
Key insight: X video is HLS (blob: MSE on the <video>, so the element src isn't
grabbable — the real stream is the video.twimg.com .m3u8 the sniffer catches),
and every video's numeric MEDIA ID appears in BOTH the HLS URL
(amplify_video/<id>/… or ext_tw_video/<id>/…) AND the poster thumbnail
(amplify_video_thumb/<id>/…). That shared id is a deterministic correlation key.
- content.js: `xVideoInfo(v)` reads the id from the hovered video's poster + a
  title from its <article> (User-Name + tweetText); Catch sends `catch-x` with
  {mediaId,title}. `reportX()` (load + scroll + 3s) ships every visible video's
  id→title so streams get named. On X, an unidentifiable video shows "Can't grab
  this" instead of the tab-level guess (the wrong-video bug).
- background.js: `xMediaId(url)` extracts the id; `noteXTitle` stores tabId→
  (id→title) and backfills already-listed streams stuck on the page title;
  addMedia names X streams via `xTitleFor`; `catch-x` downloads the sniffed HLS
  whose URL shares the id (title applied). Cleaned up on forgetTab.
- Also fixed the CWS upload blocker: manifest `description` was 164 chars (max
  132) → trimmed to 118. (Was v2.26.2.)
Tests: new test-x.js (16: id extraction from every twimg shape, correlation,
naming map, backfill guard). Suite 157/157.
NOTE (unverified live): X markup/testids can change; if naming/catch misses,
re-check `[data-testid=User-Name|tweetText]` and the twimg URL shapes.

## v2.26.1 — Fix "two separate files" split-save regression (2026-07-21)
User got a raw video + audio pair instead of one merged file = ALL mux attempts
failed → last-resort split save fired. Root cause of the failures: v2.26.0
forwarded every streamed message via its own independent `ensureOffscreen().then`
hop — NO FIFO GUARANTEE. Deadly with a live stream: the reload-from-0 `wipe`
landing after the fresh stream's `init` deletes the codec config (undecodable
track → every attempt fails); `done` racing ahead of the last fragments truncates
tracks. Fix: `forwardToOffscreen()` — ONE promise chain serializes init/data/
wipe/done/cancel in order. Also: unique WORKERFS mount point per mux attempt (a
stuck mount from a failed exec can't cascade the retries into failure), per-
attempt console.warn of the ffmpeg error, and a `[yt-mux]` diagnostic line
(track sizes/init presence/starts/seeks/plan) so any future degrade is
explainable from the offscreen console. 141/141 green.

## v2.26.0 — STREAMING CAPTURE rearchitecture (2026-07-21)
User's full-video capture of a 53:43 episode: output 34:56, started at his
playhead (8:28, page had &t=526s), audio ~5-6s early. Three causes, one rebuild:

1. **34:56 = the 1.5GB page cap truncating** (~35min of 1080p ≈ 1.5GB). Fixed
   architecturally: fragments are now STREAMED to the offscreen doc the moment
   they're appended (`tinit`/`tchunk` → `yt-cap-init`/`yt-cap-data`), decoded
   once and rolled into 32MB sub-Blobs (disk-backed). The page retains NOTHING
   during a capture → no cap (8GB sanity ceiling), no tab-OOM risk. Pre-capture,
   a 200MB passive window is retained (so an already-buffered short video still
   captures instantly) and flushed on start; overflow just drops it (reload
   path re-fetches). On reload-from-0 the hook posts `wipe` so stale shipped
   fragments are discarded.
2. **Started at 8:28** = raw `video.currentTime = 0` overridden by YouTube's
   deep-link/resume logic. New `hardSeek()` uses `player.seekTo()` (authoritative)
   for the initial seek + steering + a belt-and-braces seek after loadVideoById.
3. **Audio 5-6s early** = the SAME per-input normalization skew, now fixed for
   ALL captures: `ytTrimPlan` (offscreen, pure fn) aligns tracks whenever their
   starts differ ≥0.3s — full captures align at max(vStart, aStart) cut on a
   video keyframe; range captures trim at the keyframe ≤ rangeStart. All timing
   (`trackTimes`: tfdt ÷ mdhd timescale; `orderedIndex`: sort+dedup, append-order
   fallback <60% t-coverage) is computed offscreen FROM THE SHIPPED BYTES —
   ground truth, no page-side estimates, no captureStart/keyStart/audioStart
   plumbing (all removed).
Assembly: `trackBlob` = init + time-ordered `Blob.slice` refs (zero copy, any
size) → `ffMuxMounted` (WORKERFS) for every capture; retries mp4→mkv→video-only
→split unchanged. Removed: joinB64Parts/b64PartsToBlob/shipTrack/orderedChunks/
captureStartOf/keyStartOf/trackStartOf/pickTrack + MEMFS yt path.
"Stuck at 99%" = normal mux time on big files (popup shows Muxing…).
Tests: test-range rewritten around ytTrimPlan (41) incl. full/mid-video
regression pair; orderedIndex/trackTimes verified vs synthetic boxes. 141/141.

## v2.25.3 — THE REAL clip-sync fix: per-track seeks (2026-07-20)
User (5:51→7:55): audio now EARLY by 4-5s, video starts on target. Symptom
flipped side → v2.25.2's model was still incomplete. The DEEP cause: ffmpeg
normalizes EVERY INPUT FILE independently (ts_offset = −(its own seek target,
which includes ITS OWN start_time)). Video and audio are muxed as SEPARATE
files, and the AUDIO track usually starts a few seconds BEFORE the video track
(the player buffers audio from an earlier point; audio segments span longer).
So the same `-ss 4.1` = captureStart_v+4.1 for the video but audioStart+4.1 for
the audio → lands 4-5s earlier in content. Sharing one seek can never align
tracks whose starts differ.
Fix: the hook now measures the AUDIO track's own start (`trackStartOf` — same
tfdt/mdhd parsing on the audio track; −1 for WebM/unknown) and ships it as
`audioStart`. runYtMux computes INDEPENDENT seeks aimed at the same content
instant: vSeek = keyStart−videoStart+0.1, aSeek = keyStart−audioStart+0.1
(clamped to the audio's beginning if it starts after the keyframe). ffMux and
ffMuxMounted take (seekV, seekA); aSeek null → old shared behavior (WebM audio,
where tfdt doesn't exist — captureMp4 OFF is the one path that can still skew).
Sanity guard: |base − audioStart| < 90 or the value is ignored.
Tests: trimArgs mirror now models per-input landing positions —
"both cuts land at the SAME content instant" + "a shared seek WOULD skew by the
start gap" regression pair. test-range 48 cases; suite 148/148 green.

## v2.25.2 — Fix clip A/V skew (video 4s early, audio 4s late) (2026-07-20)
User: 5:00→7:01 clip came out ~2:01 long ✓ but video started ~4s EARLY and audio
lagged ~4s. ONE root cause, both symptoms: with `-c copy`, `-ss` cuts the VIDEO
at the keyframe ≤ target (~4:56) but cuts the AUDIO precisely at the target
(5:00) → tracks start 4s apart; `avoid_negative_ts make_zero` then shifts the
file so video sits at 0 and audio at +4s.
Fix: cut BOTH tracks at the SAME point — the video keyframe. We know exactly
where the keyframes are: every captured fMP4 fragment begins on one, so the
fragments' tfdt times (÷ mdhd timescale) are the seekable keyframe positions.
New `keyStartOf()` in yt-hook picks the fragment start ≤ rangeStart, ships it as
`keyStart` in the done event; runYtMux seeks both inputs to
`keyStart - captureStart + 0.1` (the +0.1 makes ffmpeg snap BACK onto that exact
keyframe rather than the previous one) and measures `-t` from keyStart so the
clip ends at rangeEnd. Result: A/V aligned from the first frame; clip starts at
the keyframe (≤ one fragment, ~2-5s, before the requested start — inherent to
stream copy) and ends on time. Fallbacks: keyStart implausible → cut both at
captureStart (still synced); nothing usable → no seek, end-clamp only.
Gotcha for tests: synthetic fragments must append an `mdat` after the moof —
decodeTimeOf scans only to len-12, so a bare trailing tfdt box is (correctly)
out of range; real fragments always have the mdat. Verified keyStartOf/
boxTimescale/captureStartOf against realistic synthetic boxes (v0+v1 mdhd).
test-range.js now 41 cases (skew regression: "seek is NOT the requested-start
offset"). Suite 141/141 green.

## v2.25.1 — Fix 12-second clips + ads breaking the buffer (2026-07-20)
User: clip 21:00→24:53 produced a **12-second** file, and ads still interrupt.

**Clip bug — my v2.25.0 comment was flat wrong.** I assumed input `-ss` took an
ABSOLUTE timestamp because MSE fragments carry absolute decode times. But
ffmpeg.c adds `ic->start_time` to `-ss`, i.e. **input seek is relative to the
start of the file** — and a range capture's file contains ONLY the window
(starting ~20:54). So `-ss 1260` seeked 1260s PAST 20:54, landed near the tail,
and copied the ~12s that remained. Fix: the hook now reports `captureStart` —
the true start of the captured stream in seconds, read from the fragments'
own `tfdt` decode times divided by the media timescale (new `boxTimescale()`
parses moov>trak>mdia>mdhd, v0 @+20 / v1 @+28; verified against synthetic boxes
for both versions). runYtMux seeks by `rangeStart - captureStart` (~6s, the
lead-in), clamped to <60s so a bad value can't resurrect a huge bogus seek.
Also pad `-t` by KEYFRAME_PAD=3s: a copy cuts on the keyframe AT OR BEFORE the
start, so the clip begins up to a GOP early and a bare -t would end that much
early — better slightly long than missing the end the user asked for.

**Ads.** Three changes: (1) **duration-mismatch ad detection** — an ad plays
through the SAME <video>, so `duration` becomes the ad's length; comparing it to
the content duration recorded at capture start (`state.contentDur`) catches ads
on the boundary ticks where the CSS classes lag, so ad bytes stop leaking in.
(2) **skipAd now fast-forwards the ad** (`currentTime = duration - 0.1`, guarded
to <300s so it can never touch content) — this is what actually clears
UNSKIPPABLE ads instead of waiting them out while buffering stalls. (3) capture
**never starts while an ad is showing** (waits up to ~45s, skipping) — otherwise
`v.duration` was the AD's, so the capture ended after a few seconds AND the ad
duration became the detection baseline. The measure-guard in the tick is also no
longer gated on the skipAds setting (measuring during an ad is always wrong).
Tests: test-range.js now 36 (added the trim-math regression cases, incl. "seek is
NOT the absolute range start"). Suite 136/136 green.

## v2.25.0 — Big captures auto-merge (WORKERFS) + capture a TIME RANGE (2026-07-20)
Two user asks: (1) "can we run the ffmpeg merge for the user at the backend?"
(2) "capture between particular timestamps".

**(1) Auto-merge — no more manual ffmpeg.** The old ceiling was MEMFS: `writeFile`
copies inputs INTO ffmpeg's ~2GB wasm heap, so inputs+output had to fit together
(~950MB of tracks). Confirmed the bundled core exposes **WORKERFS** (grep'd
ffmpeg-core.js: `filesystems={"MEMFS":MEMFS,"WORKERFS":WORKERFS}`, and ffmpeg.js
exposes `mount`/`unmount`). New `ffMuxMounted()` mounts the tracks as **Blobs read
lazily from disk**, so only the OUTPUT lives in the heap → the merge ceiling now
covers the full 1.5GB capture cap. `runYtMux` picks mounted vs MEMFS by size
(MEMFS_MAX 950MB). The split "two files + do it yourself" save is now only a TRUE
last resort (mounted mux AND video-only mux both failed) instead of the >950MB
default. `b64PartsToBlob` decodes parts into 64MB sub-Blobs so building the input
Blob never spikes the JS heap either.

**(2) Range capture.** New "✂️ Capture only part of it" toggle on the YouTube card
with From/To fields. End-to-end: popup validates (end>start, non-empty) → sends
rangeStart/rangeEnd → background stores them on the capture + forwards to the page
→ hook buffers ONLY that window and finalizes there → offscreen trims precisely
with input `-ss` + output `-t`, saving `Title_clip.mp4`.
Key details: the hook seeks to `rangeStart - 6s` (RANGE_LEAD_IN) so the copy-cut
lands on a keyframe at/before the requested start, then ffmpeg's -ss trims the
lead-in off exactly; `coveredEndOf(ranges, from)` now measures contiguous coverage
FROM the window start (coverage before it isn't progress); progress %, the
done-check and the incomplete-flag are all computed across the window span; the
"reload from 0" step is skipped for range captures (they start mid-video by
design); `resetMedia()` runs on a range start so earlier passive fragments from
elsewhere in the video aren't shipped. Range captures are much faster than a full
capture since only the window is buffered.
Tests: new `test/test-range.js` (27 cases: window clamping, lead-in, coverage math
with gaps, progress/completion, parseTime/fmtClock round-trip, validation).
Suite now 127/127 green.

## v2.24.4 — Capture cap 800MB → 1.5GB + oversized-capture split save (2026-07-20)
User asked for a bigger capture limit. Raised CAP_BYTES to 1.5GB (safe page-side
now that shipTrack streams single-copy). The REAL ceiling was ffmpeg.wasm: tracks
+ muxed output must fit its ~2GB wasm heap, so past ~950MB a mux would fail/OOM
and lose the capture. New split path in runYtMux: captures over YT_MUX_MAX save
the video track (Title_video.mp4/webm — concatenated fMP4/WebM plays as-is) via
the normal record flow and the audio (Title_audio.m4a/weba) via a direct anchor
save, plus a "yt-split" notification with the one-line ffmpeg merge command.
NOTE: the anchor-saved audio file lands in the default Downloads dir (subfolder
setting doesn't apply to anchor saves).

## v2.24.3 — Fix YouTube-tab OOM crash at end of capture (2026-07-20)
User's long capture (1hr+ episode) crashed the whole YouTube tab with "Out of
Memory" at 99% — exactly at ship time. Cause: `shipTrack` concatenated init + ALL
captured chunks into ONE giant Uint8Array (a full second copy of the capture)
before base64ing. Fix: group ordered chunks into ~4MB parts and encode/post each
group individually (joinB64Parts accepts unequal part sizes; single-chunk groups
ship with zero copies). Also made offscreen's `joinB64Parts` two-pass (size first,
decode directly into the final buffer) to cut the mux-side peak by ~1× track size.
NOTE: a capture that crashed this way is unrecoverable — the stuck 99% row in
Downloads can be Canceled/Removed; recapture after reloading the extension.

## v2.24.2 — Full code-review hardening pass (2026-07-20)
Reviewed every core file; all 100 tests were green before AND after. Fixed:
- **SW restart no longer discards finished downloads**: on wake, background now asks
  the (independently-alive) offscreen doc which job ids are live (`list-jobs`) and
  only fails the dead ones; browser-kind downloads are re-checked via
  `chrome.downloads.search` and re-hooked. Previously ALL active records were
  blanket-failed → `handleHlsReady` revoked the finished blob.
- **Bounded merge memory**: `assembleMedia` + `runFile` now roll completed
  segments/chunks into sub-Blobs (64MB flush, contiguous prefix) instead of holding
  the entire stream in JS heap until the final Blob (multi-GB merges crashed).
- **Live HLS detected**: playlists with no `#EXT-X-ENDLIST` (and not PLAYLIST-TYPE:
  VOD) now fail with a clear "live stream" message instead of silently saving the
  current window as a "success".
- **Verified anchor-save fallback**: `anchorSaveVerified` watches
  `downloads.onCreated` for the blob URL; no more phantom "Saved ✓" if the anchor
  click silently fails (8s timeout → real failure).
- **Settings race on SW wake**: `doDownload` / `getSubtitle` / `grabThumbnail` gate
  on `initReady` so an early event can't run with default settings.
- Smaller: downloads cap (50) no longer evicts ACTIVE records; `decodeEntities`
  uses fromCodePoint (emoji entities); `notifications.onClosed` prunes notifMap;
  `cleanTitle`'s Watch/Stream suffix-strip now requires a marketing keyword;
  `canceledIds` + offscreen `keyCache` bounded; fetch-slot accounting `id` passed
  everywhere (decryptSegment/runDash/runHls/runRedditAV); popup subs errors set via
  textContent (no innerHTML injection); yt-hook/youtube.js message listeners check
  `e.source === window`; dead `web_accessible_resources` removed from manifest;
  `igCollectVideos` redundant condition removed.
- Left as-is deliberately: feedback email in popup.js (rashikaj591@gmail.com) —
  flagged to confirm it's intended.

## v2.8.2 — Instagram rebuilt (posts/reels/stories were all broken) (2026-07-09)
User: "unable to download any reels or stories or any post." Diagnosed LIVE in the
browser: **Instagram killed the `?__a=1&__d=dis` endpoint** (now 404 + a login page)
— and that was the only thing our resolver used, so everything died together.
Rewrote it to the endpoint download tools use now:
- shortcode → numeric **media id** (base64 decode), then
  `api/v1/media/{id}/info/` with `X-IG-App-ID` + your session → `video_versions[0].url`
  is a directly downloadable progressive MP4 (byte-range capable). No CSRF needed.
- Stories: `web_profile_info` (username→id) + `feed/reels_media` (parsed the same way).
- Video URLs are now on fbcdn.net with no file extension, so we parse them out of
  the JSON structurally (the old HTML scraper would miss them).
Verified end-to-end live (200 → real MP4, HTTP 206 range). Tests: new
`test/test-instagram.js` 7/7 + resolve 12 + subs 35 + dash 19 all pass.
Note: IG rotates these endpoints — if it breaks again, re-test in a logged-in tab.

## v2.8.0 — Thumbnail grab + onboarding + review prompt (2026-07-09)
"Polish pass" to make it feel finished & shareable (picked from a direction menu).
- **🖼️ Thumbnail grab**: `content.js` sends the video's poster / page og:image; the
  scraper pulls og:image on paste results too. `grabThumbnail` in background saves
  it (YouTube → maxres w/ hq fallback via `youtubeThumb`). Buttons: "🖼️ Thumbnail"
  on the YouTube card + a 🖼 button on any video card that has a poster.
- **Onboarding banner**: first-run welcome card (4 quick tips) at the top of the
  Videos tab; "Got it" sets `vc_onboarded`.
- **Review/share prompt**: after your FIRST successful save (`markSaved` →
  `vc_hasSaved`), a "🎉 Your first save" card offers "Copy share text" (no fake
  store link — it's unpacked) + Dismiss. Appears live via storage.onChanged.
- Note: manifest had been bumped to 2.7.5 manually while reload-testing between
  sessions; set to 2.8.0. Tests still green (subs 35, resolve 12, dash 19).

## v2.6.0 — Subtitles & Transcripts (2026-06-25)
New headline feature for the study angle: download captions as **.srt**, **.vtt**,
or a clean **plain-text transcript (.txt)**. Pure JS — no ffmpeg/offscreen; the file
is saved straight from a `data:` URL.
- **YouTube**: captions aren't SABR-locked (unlike the video), so `resolveYouTubeSubs`
  fetches the watch HTML, pulls `captionTracks` (+ `translationLanguages`) out of
  `ytInitialPlayerResponse`, and fetches each track as WebVTT (`&fmt=vtt`, `&tlang=`
  for translation). Lists every language incl. auto-captions. Button: **📝 Subtitles /
  Transcript** on the YouTube card.
- **HLS**: detects `#EXT-X-MEDIA:TYPE=SUBTITLES` tracks in the master, fetches the
  sub-playlist's WebVTT segments and concatenates them. A small **CC** button shows
  on HLS cards.
- **Paste a link**: a direct `.srt`/`.vtt`/`.ttml` URL opens the format picker.
- Parsers (WebVTT, SubRip, YouTube srv1 XML, TTML) + emitters live in `background.js`.
  The .txt transcript collapses YouTube's rolling-window auto-caption duplicates.
- Tests: `test/test-subs.js` (35 cases, vm-loads the real background.js fns) — all
  pass; existing test-resolve 12/12 + test-dash 19/19 still green. UNVERIFIED only by
  real device: live YouTube fetch of timedtext (some videos may need sign-in / 0 tracks
  for age-restricted), and HLS multi-segment VTT timestamp continuity.

## Where we are: v2.3.0

Big session. Fixed a pile of real bugs and built YouTube capture. Everything
compiles, manifest is valid, 19/19 unit tests pass.

### Fixed this session
- **Clip / GIF / MP3** — were silently downloading the FULL file on sites without
  HTTP range support; now full-fetch + ffmpeg. Fixed `ffClip` seeking.
- **Save flow** — blob saves go through `chrome.downloads.download(objUrl)` now
  (real "Save as" dialog, reliable completion). Fixed the "stuck on Converting…"
  bug and the "asked twice" prompt.
- **Save location** — new "Default folder" setting (subfolder under Downloads);
  Save-As at the START for plain direct videos.
- **Pause** — now truly stops the network (aborts in-flight fetches, resumes by
  re-fetching). Before, it only stopped queuing.
- **Cancel** — now hard-aborts in-flight fetches + terminates ffmpeg if mid-convert.
- **Badge errors** — fixed the `No tab with id` console spam.
- **Catch button** — calmer (only near the top of the video), added a ✕ dismiss,
  finds videos under overlay layers (elementsFromPoint), works in fullscreen.

### Built this session: YouTube Capture (the hard way)
YouTube has NO grabbable URLs anymore (tested live: iOS API = 400, HD = SABR,
360p = 403). The only thing that works is capturing the media the player buffers
via a MediaSource hook. So:
- `yt-hook.js` (MAIN world, document_start) taps `appendBuffer`, keeps the init
  segment + media, auto-buffers the whole video at 16x by seek-chasing the
  buffered frontier, then ships the tracks.
- `youtube.js` bridges page <-> background. Background orchestrates, offscreen
  muxes video+audio to MP4 (`runYtMux`).
- Popup: red card with one button **"⬇ Capture full video"** → progress → saved.

Validated live in-browser: appendBuffer capture works, init-segment retention,
and the auto-buffer frontier advancing toward the end.

## v2.5.2 — Instagram now returns a playable file (2026-06-24)
The Instagram entries that wouldn't play were the player's raw CDN DASH/range
fetches (video-only fragments), sniffed from the network. Fixed: (1) suppress
cdninstagram.com/fbcdn.net network detections (they don't play standalone),
(2) when the popup opens on a /reel|/p page it auto-resolves via Instagram's API
(a full progressive MP4 with audio), (3) dedupe the multiple-bitrate results to
the best one. PW remains Widevine DRM — declined to build a key-extraction crack
(illegal TPM circumvention); pointed user to the PW app's built-in offline download.

## v2.5.1 — Instagram resolver + badge-spam fix; PW is Widevine (2026-06-24)
- **Badge/list spam**: a DASH lecture fires a numbered .mp4/.m4s per few seconds;
  the old isSegment only caught .ts/.m4s/range, so .mp4 segments slipped through
  and each became a list entry → badge ran away. Strengthened isSegment (init.*,
  seg/chunk/frag/media-N, bare NNNN.mp4, .cmfv/.cmfa, bytestart/byteend), collapse
  repeated .mpd requests, and a hard 40-entry cap. Verified: 9 segment patterns
  filtered, 5 real videos kept.
- **Instagram**: now resolves via Instagram's own JSON API with the public web
  App-ID header (X-IG-App-ID: 936619743392459) + embed-page fallback, reusing the
  scraper on the response (it contains the cdninstagram .mp4 URLs). Your logged-in
  cookies go too, so it works for content you can see. Private/stories still won't.
- **Physics Wallah = Widevine DRM** (confirmed by the user's screenshot: our DASH
  parser detected it and said "DRM-protected (Widevine)"). That's a hard wall — the
  same as Netflix. Non-DRM DASH lectures DO download now; DRM ones can't, by any
  clean local tool. The sites that "download PW" use extracted Widevine keys / the
  app API (gray-area, fragile) — out of scope for a trustworthy local extension.

## v2.5.0 — DASH (.mpd) support → Physics Wallah works (2026-06-24)
Screenshot showed PW lectures are **MPEG-DASH** (`.mpd`), which we'd been refusing
("DASH — not auto-mergeable"). Now implemented: `parseDash` in `offscreen.js`
parses the manifest (namespace-safe via getElementsByTagNameNS), picks the best
video + audio Representation, expands SegmentTemplate (SegmentTimeline incl. repeat
counts, or @duration), resolves BaseURL chains, and feeds the existing
assembleMedia → ffMux pipeline (DASH segments are fMP4 → clean .mp4). DRM
(Widevine/PlayReady) is detected and reported clearly (can't be downloaded).
`background.js` `mergeDash` routes type "dash" through it; `doDownload` no longer
rejects DASH. Tests: `test/test-dash.js` (19 cases on the segment/template/duration
logic) — all pass. **User: play a PW lecture, then in the popup's Videos tab the
DASH entry → Merge & Save.** If a lecture is DRM-protected it'll say so.

## v2.4.3 — gap-free capture + quality lock + more scraper patterns (2026-06-24)
User: YouTube capture works, but the video "suddenly changes and speeds up" while
audio stays fine. That's a capture-integrity bug — the video track had GAPS:
- The old auto-buffer seeked past the buffered frontier every ~2s regardless of
  whether the previous segment finished, aborting in-flight video fetches → missing
  segments → muxed video has fewer frames than audio → appears to "speed up".
  Fixed: seek a hair past the frontier, then WAIT for that region to buffer before
  seeking again (gap-free, still works in backgrounded tabs).
- At 16x in a background tab YouTube also DROPS resolution mid-stream (new init
  segment) → mixed-resolution file that glitches. Fixed: lock the player quality
  for the whole capture. Also restores your watch position when done.

Scraper: added common JSON video-URL keys (video_url, playbackUrl, hlsUrl, etc.)
to help Instagram and lecture players. 12/12 scraper tests pass.

Instagram / Physics Wallah: paste-link only works if the media URL is in the page
HTML; both are auth-gated/JS-rendered, so the reliable path is to PLAY the video
and grab it from the popup's detected list (or capture). Pending info from user on
what the popup shows for PW (HLS entry? nothing? DRM?).

## v2.4.2 — fix "Nothing captured" on already-buffered videos (2026-06-24)
After the mux crash was fixed, a short film failed with *"Nothing captured yet."*
Cause: the hook only kept media **while capturing was active** (after the click).
A short video that was already fully buffered before you clicked Capture had its
appends dropped, and the auto-buffer then found everything buffered → fired no new
appendBuffer → shipped 0 parts. Fix in `yt-hook.js`: **accumulate media from page
load** (`armed` flag, default on), and reset per-video when a **new MediaSource**
is created (the precise "new video" signal — avoids mixing videos and avoids
clipping the next video's first segment). `start` no longer wipes the
already-buffered media. In practice YouTube only buffers a window ahead, so passive
memory stays bounded (and a short video that's fully buffered is small).

## v2.4.1 — fix YouTube mux crash "ArrayBuffer already detached" (2026-06-24)
User's capture buffered to 100% then failed at mux with *"postMessage on Worker:
ArrayBuffer at index 0 is already detached."* Root cause: ffmpeg.wasm `writeFile`
**transfers** (detaches) the input buffer to its worker. The mp4→mkv fallback in
`runYtMux` reused the SAME videoBytes/audioBytes on the retry → their buffers were
already detached. The user's video is **AV1**, which the core's mp4 muxer rejects,
so it *always* hit the broken retry. Fixes in `offscreen.js`:
- `doMux` now **rebuilds the bytes from the retained base64** on every attempt
  (base64 strings are never detached), so the retry has live buffers.
- Pick the container right the FIRST time using the captured track's **codec mime**
  (av01/vp9 → `.mkv`, avc1+aac → `.mp4`) — AV1 no longer wastes a failed mp4 pass.
The mkv retry remains only as a safety net for unknown codecs.

## v2.4.0 — "Paste a link" + the final word on YouTube (2026-06-24)

**YouTube can't be downloaded by URL anymore — proven, not guessed.** Tested live
in the browser:
- Web player = **SABR**: HD formats have no URL and no cipher.
- Android/iOS/TV API clients = `LOGIN_REQUIRED` / `400` / `ERROR` (need PO tokens).
- The player's real media fetches are **POSTs to `…&sabr=1`** with the format +
  byte-range hidden in a protobuf body — not a grabbable link.

That's why paste-a-link *sites* all run **servers** (yt-dlp + a PO-token provider)
and still break weekly. A local extension can't match that — so for YouTube the
**Capture** mode (grab the stream as it plays) is the right and only local answer.

**What shipped:** a **"Paste a link"** box at the top of the Videos tab. Paste any
non-YouTube video page or file URL → background scrapes it (og:video, `<video>`/
`<source>`, JSON-LD, m3u8/mpd/mp4 in the page, even escaped-slash URLs in JSON) →
shows download options that run through the existing pipeline. YouTube links route
you to Capture mode. New `test/test-resolve.js` covers the scraper (10/10 pass).

## v2.3.1 — mux container fix (capture LIVE-TESTED, 2026-06-24)
Injected the capture hook into a real /watch page and inspected the bytes:
- **Video** comes as **fMP4** (AV1/H264) — clean `ftyp`+`moov` init + `moof/mdat`.
- **Audio** comes as **WebM/Opus** (`1A 45 DF A3` EBML). Many videos are
  **both-webm** (VP9 + Opus).
- Both concatenations validated as proper containers.

**Bug found & fixed:** `runYtMux` assumed both tracks were mp4 and always wrote
`out.mp4`. That mis-handles webm and, critically, **VP9-in-mp4 `-c copy` is
rejected by ffmpeg** → the common case would fail. Now `offscreen.js`:
- `sniffContainer(bytes)` detects webm vs mp4 from magic bytes.
- `ffMux`/`ffRemux` take an output extension.
- Output is **`.mp4` only when both tracks are mp4-family, else `.mkv`**
  (Matroska copies any codec combo losslessly), with an mp4→mkv fallback.

Couldn't run ffmpeg.wasm to fully prove it — YouTube enforces Trusted Types (no
script injection) and the 28 MB of captured bytes can't be moved to a permissive
tab. The ffmpeg exec needs the loaded extension's offscreen doc.

## ⏳ NEXT STEP (resume here) — TEST THE MUX END-TO-END
The ONE thing not yet verified (needs the extension actually loaded, which the
automation can't do):

1. Go to `chrome://extensions` → **Reload** Video Catch.
2. Open a SHORT YouTube video.
3. Popup → **⬇ Capture full video** → wait for it to buffer + save.
4. Check the saved MP4 plays with both video AND audio.
5. If broken/empty: open the extension's **service worker console** AND the
   **page console (F12)**, copy the errors, and give them to Claude.

Most likely fix-spot if it fails: the `ffMux` of captured fMP4 in `offscreen.js`
(`runYtMux`), or document_start timing of the init segment.

## Known limits / next ideas
- Capture grabs the quality the player streamed (usually up to 1080p).
- **Ads would be captured into the file** for non-Premium accounts — no ad-skip
  yet. This is the likely next feature to build.
- Files: `manifest.json`, `background.js`, `offscreen.js`, `popup.*`, `content.js`,
  `youtube.js`, `yt-hook.js`. ffmpeg in `vendor/ffmpeg/`.

To resume: just tell Claude "continue the Video Catch YouTube capture — test the
mux" and it'll have all this in memory.
