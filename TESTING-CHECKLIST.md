# Video Catch — Manual Test Checklist

Work through this on a real device with the extension loaded (`chrome://extensions`
→ Reload). Keep the **service-worker console** open (Video Catch → "service
worker") and, for capture tests, the **offscreen.html** console — the `[VideoCatch]`
and `[yt-mux]` lines explain any failure. Check a box only when it passes on a real
site.

Legend: 🔴 critical (blocks a good experience) · 🟡 important · ⚪ nice-to-have

---

## A. Install & basics
- [ ] 🔴 Loads with no errors in the service-worker console on install/reload.
- [ ] 🔴 Toolbar icon + popup open; header shows the correct video count.
- [ ] 🟡 First run shows the welcome/onboarding banner; "Got it" dismisses it.
- [ ] 🟡 Badge shows the count of detected videos on a tab.
- [ ] ⚪ Settings gear opens; all toggles reflect saved state.

## B. Progressive video (MP4/WebM) — the simple path
- [ ] 🔴 Play a direct MP4 site → popup lists it → **Download** saves a playable file.
- [ ] 🔴 File is named after the video/page title, not a cryptic URL.
- [ ] 🟡 "Ask where to save" ON → native Save-As appears at the START of the download.
- [ ] 🟡 "Default folder" set → file lands in Downloads/<that folder>/.
- [ ] 🟡 A large MP4 (>800 MB) still downloads (falls back to normal browser download).
- [ ] ⚪ Download speed Normal/Fast/Turbo all work; Turbo isn't rate-limited (429).

## C. HLS streams (.m3u8)
- [ ] 🔴 Play an HLS video → card shows **Merge & Save** + a quality dropdown.
- [ ] 🔴 Merge → one clean MP4 that plays with **video AND audio in sync**.
- [ ] 🟡 Quality picker lists resolutions; "Auto (best)" picks the highest.
- [ ] 🟡 Progress % climbs; Converting… shows; Saved ✓ at the end.
- [ ] 🟡 A stream with separate audio track → audio is muxed in (not silent).
- [ ] 🟡 **CC** button lists subtitle tracks and downloads them.
- [ ] ⚪ AES-128 encrypted (non-DRM) HLS still merges.
- [ ] 🔴 A **LIVE** stream is refused with a clear "live stream" message (not a 30s file).

## D. DASH (.mpd)
- [ ] 🟡 A non-DRM DASH video → Merge & Save → clean MP4 with audio.
- [ ] 🔴 A **DRM (Widevine)** DASH (e.g. some lecture apps) → clear "DRM-protected" message, no broken file.

## E. YouTube capture (the fragile area — test hardest)
- [ ] 🔴 `/watch` page → popup shows the red **Capture** card with the right title.
- [ ] 🔴 **⬇ Capture full video** → buffers to 100% → saves an MP4/MKV that plays.
- [ ] 🔴 Saved file has **both video AND audio, in sync**, named the real title.
- [ ] 🔴 Timeline shows the **real duration** (no 13-hour tail, no black-out at the end).
- [ ] 🔴 A **50+ min** video captures in FULL (no ~35-min truncation).
- [ ] 🔴 Opening via a **`&t=` deep link** (or mid-watch) → capture still **starts at 0:00**.
- [ ] 🟡 Tab memory stays roughly flat during a long capture (Task Manager).
- [ ] 🟡 **Range capture** ("✂️ Capture only part of it", e.g. 1:30–4:00) → clip is that window, audio in sync, named `_clip`.
- [ ] 🟡 Empty/invalid range → inline warning, capture doesn't start.
- [ ] 🟡 **Ads**: a pre/mid-roll ad is skipped/fast-forwarded, not spliced into the file, progress doesn't fake-advance.
- [ ] 🟡 **📝 Subtitles/Transcript** lists languages (incl. auto), downloads SRT/VTT/TXT, translation works.
- [ ] 🟡 **🖼️ Thumbnail** saves the max-res poster.
- [ ] ⚪ Rentals/DRM movies → reported as un-capturable, not a broken file.
- [ ] ⚪ If a capture ever splits into two files, both play + the ffmpeg merge notification shows (rare fallback).

## F. X / Twitter
- [ ] 🔴 Playing a video → each stream is named after **its own tweet** (not "Home / X").
- [ ] 🔴 In-video **Catch** button grabs **exactly the hovered video** (not a different one).
- [ ] 🟡 An unidentifiable video (ad tile) shows "Can't grab this" instead of the wrong video.
- [ ] 🟡 Merge & Save → MP4 with audio.

## G. Instagram
- [ ] 🟡 A post/reel page auto-resolves to a playable MP4 (with audio).
- [ ] 🟡 Catch button on a FEED video grabs that specific reel.
- [ ] 🟡 Stories (while logged in) resolve; image-only stories say so clearly.
- [ ] ⚪ Private/login-gated content fails with a helpful message, not a crash.

## H. Reddit
- [ ] 🟡 A Reddit video → ONE clean entry named the post headline (not 3 duplicates).
- [ ] 🟡 Download → MP4 **with audio**.
- [ ] 🟡 Catch button appears over the player (shadow-DOM) and grabs that clip.

## I. Paste a link
- [ ] 🟡 Paste a direct MP4/HLS/DASH URL → download options appear.
- [ ] 🟡 Paste a page URL → scrapes and offers the media.
- [ ] 🟡 Paste a YouTube URL → routed to Capture with an explanation.
- [ ] 🟡 Paste a direct .srt/.vtt → subtitle format picker.
- [ ] 🟡 Header count includes the pasted result (reads "1 video found", not "no videos yet").

## J. Tools (on a downloadable video)
- [ ] 🟡 **🎵 MP3** → audio-only file that plays.
- [ ] 🟡 **✂️ Clip** with a From/To range → trimmed MP4, audio in sync.
- [ ] 🟡 **🎞️ GIF** with a range (≤20s) → a GIF.
- [ ] ⚪ End-before-start is rejected with a message.

## K. Downloads tab (lifecycle)
- [ ] 🔴 Active download shows live progress; **Pause** truly stops the network; **Resume** continues.
- [ ] 🔴 **Cancel** stops it AND leaves no partial file behind.
- [ ] 🔴 A failed/canceled row offers **Retry**; retry works even after a browser restart.
- [ ] 🟡 Two+ downloads at once → **⚡ Prioritize** speeds the chosen one.
- [ ] 🟡 **Show in folder** opens the saved file; **Remove** clears the row.
- [ ] 🟡 **Clear finished** removes only completed rows, keeps active ones.
- [ ] 🔴 Reload the extension mid-download → the finished file is NOT lost (SW-restart recovery).

## L. Settings
- [ ] 🟡 Each toggle (Auto-prompt, Ask where to save, Convert to MP4, In-video button, Skip ads, Save YouTube as MP4) persists and takes effect.
- [ ] 🟡 Default folder + speed persist across popup reopens and browser restart.
- [ ] ⚪ Turning off the in-video button hides the Catch overlay everywhere.

## M. Edge cases & safety
- [ ] 🟡 A `blob:` URL is listed but disabled ("Blob") — not offered as a broken download.
- [ ] 🟡 Netflix/Disney+ (DRM) → detected and refused, no broken file.
- [ ] 🟡 Navigating a tab to a new page clears its old detections (no stale/wrong grab).
- [ ] ⚪ Notifications appear for detect/prompt and complete/fail (if Auto-prompt on).
- [ ] ⚪ The one-time "first save" share card appears after your first successful save.

## N. Cross-browser (optional but valuable)
- [ ] ⚪ Works loaded in Microsoft Edge (same MV3 engine).
- [ ] ⚪ Basic smoke test on a second machine / fresh profile.

---

### Known accepted issue (not a blocker)
- YouTube **range clips** can still occasionally have a small A/V offset. It's
  intermittent. If it happens, grab the `[yt-mux]` line from the offscreen console
  — that's the data needed to finally fix it.

### If something fails
Capture the relevant console line (`[VideoCatch]` service worker, `[yt-mux]`
offscreen) and the site/URL. Those two things point straight at the cause.
