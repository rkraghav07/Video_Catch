# Video Catch — Pre-Release QA Checklist (v2.13.2)

Consolidated list of **everything we built and every bug we fixed**, so we can
re-verify it all in one final pass before publishing. Check each box on a real
device (extension reloaded via `chrome://extensions`).

**Before testing:** `chrome://extensions` → Video Catch → **Reload**. Confirm the
`declarativeNetRequest` permission prompt is accepted. Keep the **service-worker
console** open (Video Catch → "service worker") to catch `[VideoCatch]` errors.

---

## 1. YouTube (capture via MediaSource)
- [ ] On a `/watch` page, popup shows the red **Capture** card with the correct video title.
- [ ] **⬇ Capture full video** buffers to 100% and saves an MP4/MKV that plays.
- [ ] Saved file has **both video AND audio**, in sync.
- [ ] File is named the **actual video title** (not "youtube-video"). *(fix v2.11.1)*
- [ ] Timeline shows the **real duration** — no "13-hour" length, no black-out/crash at the end. *(fix v2.13.0)*
- [ ] The **last ~1 second** is present (not cut off). *(fix v2.12.0)*
- [ ] **Ads are skipped** during capture — the "Skip" button gets clicked; double/back-to-back ads both skipped. *(fix v2.11.0 / v2.11.1)*
- [ ] Ads are **not** spliced into the saved file (no mid-video glitch from an ad). *(fix v2.9.1)*
- [ ] Capture **stops** when done — no restart, MB counter doesn't climb after completion. *(fix v2.11.0)*
- [ ] Ad-block only active **during** capture (session DNR rules removed after). *(v2.12.0)*
- [ ] **📝 Subtitles / Transcript** button: lists languages (incl. auto), downloads SRT/VTT/TXT, translation works.
- [ ] **🖼️ Thumbnail** button saves the max-res poster.

### 1a. Range capture (v2.25.0)
- [ ] "✂️ Capture only part of it" reveals From/To; button label becomes "Capture this part".
- [ ] Empty end time / end ≤ start → inline warning, capture does NOT start.
- [ ] A window (e.g. 1:30–4:00) buffers **only** that part (much faster than full) and progress runs 0→100% for the clip, not the whole video.
- [ ] Saved file is named `Title_clip.mp4` and starts at ~the requested second (≤ a few seconds early is expected — keyframe cut).
- [ ] Clip has **audio in sync** and ends at the requested end time.
- [ ] Start time past the video's end → clear error, no capture.
- [ ] A range capture right after a full one doesn't include stale fragments from the earlier pass.
- [ ] **A long window returns the FULL length** — e.g. 21:00→24:53 gives ~3:53, not a few seconds. *(fix v2.25.1)*
- [ ] **Audio and video are in sync from the very first frame** — audio neither lags *(v2.25.2)* nor leads *(v2.25.3)*; check lips/beats at the start AND at the end of the clip.
- [ ] Clip starts at the keyframe just before the requested time (≤ ~5s early is expected) and **audio starts with it**, not at the requested second. *(v2.25.2)*
- [ ] The clip reaches the requested **end** (±1s). *(v2.25.1/2)*
- [ ] Works on a video whose window starts near 0 (e.g. 0:02→0:30).

### 1c. Ads during capture (v2.25.1)
- [ ] A **pre-roll ad** delays the capture rather than breaking it — status shows "Skipping an ad…", then buffering starts and the file is full-length.
- [ ] A **mid-roll ad** is skipped/fast-forwarded; buffering resumes and the saved file has no ad spliced in and no glitch at that point.
- [ ] An **unskippable** ad (no Skip button) still clears quickly via fast-forward.
- [ ] Progress % does **not** jump around or record fake progress while an ad is on screen.
- [ ] With "Skip ads while capturing" **off**, ad bytes are still never written into the file.

### 1b. Large capture auto-merge (v2.25.0)
- [ ] A capture over ~950MB (long/high-quality video) still saves **ONE merged file** — no "separate video + audio" notification.
- [ ] The YouTube tab does **not** crash with "Out of Memory" at the end of a long capture. *(fix v2.24.3)*
- [ ] If the split fallback ever does trigger, both files play and the notification shows the ffmpeg merge command.

### 1d. Streaming capture (v2.26.0)
- [ ] A **50+ min video captures in FULL** — output length matches the video, no ~35-min truncation. *(fix v2.26.0)*
- [ ] Tab memory stays roughly FLAT during a long capture (Task Manager) — fragments stream out live.
- [ ] Opening a video via a **`&t=` deep link** (or mid-watch) and capturing full → the file **starts at 0:00**, not the playhead. *(fix v2.26.0)*
- [ ] A full capture that DID begin mid-video (e.g. reload unavailable) still has **audio/video in sync**. *(fix v2.26.0)*
- [ ] A short, already fully-buffered video still captures instantly (passive window flush).
- [ ] Canceling mid-capture frees everything (no stuck offscreen memory; new capture works right after).
- [ ] Capture → navigate to another video → capture again: second file contains only the second video.

## 2. Reddit
- [ ] Playing a Reddit video → popup shows **one** clean entry (not 3 duplicates), named the **post headline**. *(fix v2.10.0)*
- [ ] Download → MP4 **with audio**, correct name, no "conversion failed". *(fix v2.11.0 / v2.13.0)*
- [ ] **Catch button** appears over the Reddit player (shadow-DOM). *(fix v2.10.0)*
- [ ] Catch downloads the **specific hovered video** (correct one on a multi-video feed), not a stale/old one. *(fix v2.12.0)*
- [ ] "✓ Sent" shows only on the clicked video, not all of them. *(fix v2.12.0)*
- [ ] After a **page refresh**, Catch does not download the previous video. *(fix v2.12.0)*
- [ ] **Paste a Reddit link** → resolves the real post title (not "Reddit - The heart of the internet") and downloads with audio. *(fix v2.13.0 / v2.13.1)*
- [ ] **Clip** (with a time range) → saves `..._clip.mp4` of just that range. *(fix v2.13.2)*
- [ ] **MP3** → saves `.mp3` (audio only). *(fix v2.13.2)*
- [ ] **GIF** (range, ≤20s) → saves `.gif`. *(fix v2.13.2)*

## 3. Instagram
- [ ] Open a **reel/post** → auto-resolves a playable MP4 with the right name. *(via media/info API — v2.8.2)*
- [ ] **Stories** (`/stories/user/`) → downloads while logged in. *(v2.8.1 / v2.8.2)*
- [ ] Paste an Instagram post/reel link → downloads.
- [ ] Single clean entry (bitrate duplicates de-duped), not the raw CDN fragments.

## 4. Paste-a-link (general)
- [ ] Direct `.mp4`/`.m3u8`/`.mpd` URL → downloads/merges.
- [ ] A normal video page (og:video / `<video>` / JSON) → finds the video.
- [ ] A `.srt`/`.vtt` link → opens the subtitle format picker.
- [ ] YouTube link → routed to Capture with a clear message.

## 5. Streams (HLS / DASH) on other sites
- [ ] Play an HLS video elsewhere → detected, **Merge & Save** → clean MP4 (quality picker works).
- [ ] DASH (`.mpd`) site → merges to MP4.
- [ ] **CC** button on HLS cards → subtitle tracks download.
- [ ] DRM (Widevine, e.g. some PW/Netflix) → detected and **reported clearly**, not a broken file. *(boundary — we do NOT crack DRM)*

## 6. Clip / GIF / MP3 (non-Reddit)
- [ ] Direct video: Clip / GIF / MP3 each produce the right trimmed/converted output.
- [ ] HLS/DASH: same via the ⋯ tools menu.

## 7. Thumbnails
- [ ] 🖼 button on a page video (with a poster/og:image) saves the image.

## 8. Downloads tab
- [ ] Live progress, correct names, Pause/Resume/Cancel/Retry all work.
- [ ] "Show in folder" and "Remove" work; "Clear finished" clears only finished.
- [ ] A canceled download actually stops the network/ffmpeg (not just the row). *(v2.2.2)*
- [ ] **5 large HLS downloads at once**: no `ERR_INSUFFICIENT_RESOURCES`; fetch runs at a good speed (not throttled). *(semaphore v2.22.0 / speed v2.23.0)*
- [ ] During processing the bar shows a real **"Processing… N%"** that climbs — **no blinking sweep** in the first 5%. *(v2.23.0)*
- [ ] With several finishing together, they process **one at a time and save progressively** (first done saves first); waiting ones show **"Waiting to process…"**. *(v2.23.0)*
- [ ] Cancel a download while it shows "Waiting to process…" → cancels cleanly and the next queued one proceeds. *(v2.23.0)*
- [ ] **Failed download → Retry** actually restarts (shows progress), does NOT get stuck on "Canceled". *(fix v2.23.1)*
- [ ] With **2+ downloads** active, each row shows **⚡ Prioritize**; clicking it badges that row **⚡ Priority** and it gets first dibs on connections + jumps the convert queue; clicking again clears it; only one at a time. *(v2.24.0)*

## 9. Settings
- [ ] Auto-prompt, Ask-where-to-save, Default folder, Convert-to-MP4, In-video button, **Skip ads while capturing**, Download speed — all persist and take effect.

## 10. Onboarding / feedback (first-run polish)
- [ ] Fresh profile: **welcome banner** shows once; "Got it" dismisses. *(v2.8.0)*
- [ ] After the **first successful save**: "🎉 first save" card with **Copy share text** + Dismiss. *(v2.8.0)*
- [ ] Footer **💬 Feedback** opens a prefilled email. *(v2.9.0)*
- [ ] **Refresh** button visibly re-scans the page. *(v2.11.0)*

---

## Known limitations (expected, not bugs)
- **YouTube** can't be downloaded by URL (SABR) — capture is the only local method; needs the player running; age-restricted/members videos may not capture.
- **DRM** (Widevine: Netflix, some Physics Wallah premium) — cannot be downloaded by any clean local tool; we detect + report and point to the official offline feature. We do **not** build DRM circumvention.
- **TikTok** — banned in India; can't be tested/used from here (no resolver built).
- **Instagram/Reddit** APIs rotate — if they break, re-test live and update the endpoints.
- **MP3** currently fetches the full video then extracts audio (correct, not faster).
- ffmpeg core may lack libmp3lame (MP3 → falls back to `.m4a`) / libx264 (clip re-encode is best-effort).

## Not built yet (roadmap)
- Facebook / Twitter(X) resolvers, batch/playlist grab, store-listing demo GIF,
  DASH subtitle tracks, the content-repurposing product (reuses the transcript engine).

## Site coverage matrix (test a sample from each row before release)

**Legend:** ✅ dedicated support · 🟢 should work via detection/paste (verify) · ⚠️ needs a resolver (hidden URL) · ⛔ DRM — detect & report, cannot download.

### Social / short-form
- ✅ **YouTube** (capture) · ✅ **Instagram** (reels/posts/stories) · ✅ **Reddit** (CMAF video+audio)
- ⚠️ **Facebook** (hd_src / DASH in page JSON, auth-gated) — *high priority resolver*
- ⚠️ **Twitter / X** (HLS m3u8 via guest token; often 🟢 caught when playing) — *high priority*
- ⚠️ **TikTok** (URL in `__UNIVERSAL_DATA…` JSON) — **banned in India, can't test here**; needed for global
- 🟢 **Pinterest, Tumblr, LinkedIn, Threads, Bluesky, Snapchat Spotlight** (verify play-detect / paste)

### Video platforms
- 🟢 **Vimeo, Dailymotion, Twitch (clips + VODs), Rumble, Odysee, Bitchute** (HLS/DASH → detection)
- ⚠️ **Bilibili** (DASH, region/signature) — lower priority

### Embedded players (very common on blogs/news/course sites)
- 🟢 **JW Player, Video.js, HLS.js, Brightcove, Kaltura, Wistia** — these stream HLS/DASH → our sniffer should catch them. **Test a few news articles + blog embeds.**

### Education (India-relevant — user's context)
- ⛔ **Physics Wallah premium, Unacademy, Vedantu, BYJU'S (DRM ones)** — Widevine → report + route to official offline app
- 🟢 **Non-DRM PW/lecture DASH, NPTEL/Swayam, Khan Academy** (YouTube-hosted or plain HLS/DASH)
- 🟢 **Udemy/Coursera** — often HLS (some DRM); test one non-DRM course
- 🟢 **Google Drive / Classroom shared videos** (usually a direct download)

### Cloud / file / misc
- 🟢 **Google Drive, Dropbox, OneDrive shared video links**, direct **.mp4/.webm** links, **Telegram web** media
- 🟢 **General long-tail video sites** (most are plain HLS/MP4 → detection or paste)

### DRM — cannot download (by any clean local tool)
- ⛔ **Netflix, Prime Video, Disney+/Hotstar, JioCinema, Sony LIV, Zee5, Spotify** — Widevine/PlayReady. We **detect and say so**; we do NOT build circumvention.

### Priority to build before/after release
1. **Facebook** resolver (huge, India-accessible, testable)
2. **Twitter / X** resolver (guest-token HLS)
3. Broad **embedded-player smoke test** (news/blog/course sites via detection) — likely already works, just confirm
4. TikTok — only if targeting outside India (can't verify locally)

---

## Validation status
- `node --check` clean on all 6 scripts.
- Unit tests: `test/test-instagram.js` (7), `test/test-subs.js` (35),
  `test/test-resolve.js` (12), `test/test-dash.js` (19) — all passing.
- Live-verified earlier via Claude-in-Chrome: Instagram media/info API, Reddit
  CMAF audio/video URLs, YouTube title source. Everything else pending this final pass.
