# Video Catch — Clip, Convert & Save

A Chrome/Edge (Manifest V3) extension that catches videos playing in your browser
and turns them into exactly what you want — **all 100% on your device, nothing
uploaded to any server.**

- 🔗 **Paste a link** — drop any video page or file URL and get download options
- ⬇️ **Download** progressive videos and **merge HLS *and* DASH streams** into one clean `.mp4`
- 🎓 **Lecture platforms** (e.g. Physics Wallah) that stream DASH (`.mpd`) — play, then download from the popup
- 🎵 **Extract audio** as MP3 (or M4A)
- ✂️ **Trim a clip** — download just the seconds you want (including a
  **timestamp range on YouTube** — only that part gets buffered, so it's fast)
- 🎞️ **Export a GIF** from any range
- 📝 **Subtitles & transcripts** — grab captions as `.srt`, `.vtt`, or a clean
  plain-text transcript. Works on YouTube (any language, auto-captions, and
  on-the-fly translation), HLS subtitle tracks, and direct `.srt`/`.vtt` links
- 🖼️ **Grab the thumbnail** — save a video's poster/cover image (max-res for YouTube)
- 🔘 **In-video "Catch" button** appears when you hover a video
- 📥 **Downloads tab** with live progress, and a **quality picker** for HLS
- ▶️ **YouTube capture** — YouTube blocks direct downloads (SABR), so Video Catch
  grabs the stream *as it plays* instead (the only thing that works without a server)

The heavy lifting (remux, audio muxing, MP3/GIF/clip) runs locally via a bundled
**ffmpeg.wasm** — no accounts, no tracking, no cloud.

## How it works

- **Network sniffing** (`background.js`): watches requests via `webRequest` and
  flags anything that looks like video (`video/*` content-type, or `.mp4 .webm
  .mov .m3u8 .mpd …` URLs).
- **Page detection** (`content.js`): reports `<video>` elements as they start
  playing.
- **The prompt**: when a new video is detected, a desktop notification appears
  with **Download** / **Ignore** buttons. Toggle this off with the "Auto-prompt"
  switch in the popup.
- **The popup**: click the toolbar icon to see every video found on the tab and
  download any of them on demand. The toolbar badge shows the count.

## Install (Load Unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder:
   `C:\Users\RK\video-downloader-extension`
4. Pin the extension, play a video on any site, and watch for the prompt.

> If you edit the code, re-run `node generate-icons.js` only when changing icons,
> then hit the **Reload** button on the extension card.

## Real MP4 + audio merging (ffmpeg.wasm)

The extension bundles **ffmpeg.wasm** (runs 100% locally — nothing is uploaded):

- HLS streams are remuxed into a **clean `.mp4`** (stream-copy, no re-encode, fast).
- Streams that deliver **audio as a separate track** are **muxed back together**,
  so you no longer get a silent video.
- It's all on-device; if ffmpeg can't run for some reason, the extension safely
  falls back to saving the raw `.ts` so a download is never lost.
- Toggle via **Settings → Convert to MP4**.

### Setup (already done locally)

The ffmpeg core (~32 MB) lives in `vendor/ffmpeg/`. After a fresh `npm install`
it's re-vendored automatically (`postinstall`), or run it manually:

```
npm run setup-ffmpeg
```

## Streams are split into segments — and that's handled

Most sites deliver video as an **HLS** stream: a `.m3u8` playlist pointing at
hundreds of small `.ts`/`.m4s` segments. For these, the popup button says
**"Merge & Save"**. When clicked, the extension:

1. fetches the playlist (picking the highest quality if it's a master playlist),
2. downloads every segment (6 at a time, with a live % on the toolbar badge),
3. decrypts them if the stream uses **AES-128**,
4. concatenates them into a single `.ts` (or `.mp4` for fMP4) file and saves it.

The merge runs in an *offscreen document* (`offscreen.js`) because MV3 service
workers can't build blob downloads.

## Tabs: Videos & Downloads

- **Videos** — everything detected on the current tab, with download/merge buttons.
- **Downloads** — a live list of what's downloading (with progress bars),
  what's finished, and what failed. Each active row has **Pause / Resume** and
  **Cancel**; failed or canceled rows offer **Retry** (the original request is
  remembered, so it works even after a browser restart) and **Remove**. The tab
  shows a count of active downloads, and **Clear finished** removes finished
  rows. History persists across popup opens and browser restarts.

## Saving options (gear icon → Settings)

- **Filename** defaults to the **video / page title** (cleaned of " - YouTube"
  style suffixes) instead of a cryptic URL name.
- **Ask where to save** — turn this on for the native "Save as…" dialog. For a
  plain direct video the dialog appears at the **start** of the download; for
  merged/converted videos (HLS, clips, GIFs, MP3) it can only appear once the
  file is assembled (there's no API to reserve a path up front), so it shows at
  the **end**. Either way it's saved through the downloads API now (not an
  invisible anchor click), so the dialog and renaming actually work.
- **Default folder** — leave "Ask where to save" off and set a subfolder name
  (e.g. `Video Catch`) to silently save everything to `Downloads/Video Catch/`
  with no dialog at all. (The downloads API only allows subfolders *under*
  Downloads — not arbitrary absolute paths.)
- **Quality** — for HLS, a dropdown lists every available resolution (1080p,
  720p…). "Auto (best quality)" picks the highest. Separate audio tracks are
  detected from the master playlist and muxed in automatically.
- **Download speed** — pick **Normal (8×)**, **Fast (16×)**, or **Turbo (28×)**
  parallel connections. Applies to both HLS segments and regular MP4s:
  - **HLS** fetches that many segments at once.
  - **Regular MP4s** are downloaded with a built-in *accelerator* — the file is
    split into 4 MB byte-range chunks pulled in parallel (like IDM), then
    reassembled. Falls back to the normal browser download if the server doesn't
    support range requests, or for files over 800 MB (to avoid high memory use).
  - If a site rate-limits (HTTP 429) on Turbo, drop to Fast or Normal.

## Limitations (be aware)

- **Progressive MP4/WebM** download cleanly as a single file.
- **HLS (`.m3u8`)** is merged automatically (see above) for unencrypted and
  AES-128 streams. The output `.ts` plays in VLC and most players; remux with
  `ffmpeg -i in.ts -c copy out.mp4` if you want a clean `.mp4` container.
- **DASH (`.mpd`)** is detected but not auto-merged yet — use `yt-dlp`/`ffmpeg`
  with the URL.
- **YouTube** — handled by **capture**, not URL-grabbing. YouTube's streams have
  no downloadable URLs anymore (HD is server-driven *SABR*; even 360p needs the
  player's obfuscated `base.js` to descramble). So instead we tap the media the
  player itself buffers (via a MediaSource hook) and mux it into a clean MP4.
  Open a video and click **⬇ Capture full video** — it fast-forwards to buffer
  the stream, then muxes and saves it. To grab just a section, tick
  **✂️ Capture only part of it** and enter From/To times (e.g. `1:30` → `4:00`):
  only that window is buffered and the result is saved as `Title_clip.mp4`.
  Caveats: quality is whatever the player streamed; rentals/movies (Widevine DRM)
  can't be captured; captures are capped at 1.5 GB.
- **DRM (Widevine / SAMPLE-AES)** — e.g. Netflix, Disney+ — **cannot** be
  downloaded. The extension detects this and tells you instead of producing a
  broken file.
- **`blob:` URLs** can't be fetched by the downloader, so they're listed but
  disabled.
- Some servers reject requests that lack the original page's referer/cookies; a
  segment may then 403 and the merge fails. This varies by site.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension config & permissions |
| `background.js` | Detection, prompt notifications, downloads |
| `content.js` | Reports playing `<video>` elements |
| `popup.html/.css/.js` | Toolbar UI listing detected videos |
| `generate-icons.js` | Regenerates the PNG icons |
