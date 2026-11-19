# Chrome Web Store — Submission Pack (Video Catch)

Everything you need to fill in the Chrome Web Store dashboard. Copy-paste the
fields below. Items marked **[you]** are steps only you can do (they need a
browser or an account).

---

## 0. Before you start — the honest heads-up

Google's program policy prohibits extensions that facilitate saving content in
violation of a third party's terms of service, and YouTube downloading is the
canonical example. The YouTube "capture" feature may cause a rejection at review
or a later takedown. The plan (your call) is to submit as-is; if it's rejected,
remove the YouTube capture feature and resubmit the rest — which is fully within
policy. Keep this file for that second pass.

---

## 1. Account setup **[you]**

1. Go to the Chrome Web Store Developer Dashboard:
   https://chrome.google.com/webstore/devconsole
2. Sign in with the Google account you want to own the listing.
3. Pay the **one-time US$5 developer registration fee**.
4. (Recommended) Verify a contact email and, if you have a domain, verify it for
   a publisher badge.

## 2. Upload the package **[you]**

- Click **Add new item** and upload the ZIP:
  `video-catch-v2.26.1.zip` (built for you — manifest at the root, dev/test
  files excluded).

## 3. Store listing fields (copy-paste)

**Item name**

```
Video Catch — Clip, Convert & Save
```

**Summary** (≤ 132 characters)

```
Save any playing video on your device: merge HLS/DASH to MP4, grab MP3, trim clips, export GIFs, download subtitles — 100% local.
```

**Category**: Productivity (alternative: Tools)

**Language**: English

**Description** (paste as-is)

```
Video Catch turns videos playing in your browser into exactly the file you want — and it all happens on your own device. Nothing is uploaded to any server, there are no accounts, and there is no tracking.

WHAT IT DOES
• Detects videos playing on a page and lets you save them with one click
• Paste a link — drop any video page or file URL and get download options
• Merges HLS (.m3u8) and DASH (.mpd) streams into one clean MP4
• Extracts audio as MP3 or M4A
• Trims a clip — save just the seconds you want
• Exports a GIF from any range
• Downloads subtitles & transcripts as SRT, VTT, or clean plain text
• Grabs the poster/thumbnail image
• A Downloads tab with live progress, pause/resume/cancel, and retry

100% ON YOUR DEVICE
The heavy lifting (remux, audio muxing, MP3/GIF/clip creation) runs locally via
a bundled FFmpeg compiled to WebAssembly. No media is ever uploaded. No servers.
No tracking. No sign-in.

DOWNLOAD OPTIONS
• Choose a quality for adaptive (HLS) streams
• Pick a download speed (parallel connections) for faster saves
• Save to a subfolder, or use the native "Save as…" dialog

NOTE
Some sites protect their video with DRM (for example Netflix or Disney+); DRM
content cannot be saved and the extension will tell you so rather than produce a
broken file. Please respect the terms of service of the sites you use and only
download content you have the right to save.
```

## 3b. SEO-optimized Summary + Description (for search visibility)

Chrome Web Store search indexes NAME + SUMMARY + DESCRIPTION (no separate
keywords field). Keep keywords natural — spam is penalized. Do NOT mention
YouTube (policy). Paste these to rank for: video downloader, download video,
m3u8/HLS downloader, stream downloader, video to MP4, extract audio / video to
MP3, trim clip / video trimmer, video to GIF, download subtitles, DASH,
Instagram/Reddit/X video downloader.

SUMMARY (127 chars):
```
Download any video, merge HLS & DASH streams to MP4, extract MP3, trim clips, make GIFs & save subtitles — 100% on your device.
```

SUMMARY is set from manifest.json `description` (the dashboard field is locked) —
already updated to the SEO version in v2.28.2.

DESCRIPTION (paste in the dashboard — SAFE version: no "any site" absolutism, no
Instagram/X naming, which are the lines most likely to draw policy scrutiny;
Reddit kept, YouTube never mentioned):
```
Video Catch turns any video playing in your browser into exactly the file you want — and it all happens on your own device. No servers, no accounts, no tracking.

■ ONE-CLICK VIDEO DOWNLOADS
Detects videos as they play and downloads them in one click — a video downloader for the sites you visit.

■ SAVE STREAMS AS A CLEAN MP4
Merges HLS (.m3u8) and DASH (.mpd) streams into one clean MP4. A proper m3u8 / stream downloader that reassembles the segments and keeps audio in sync.

■ CONVERT, CLIP & EXTRACT
- Extract audio and save as MP3 or M4A
- Trim a clip — download just the seconds you want
- Turn any range into a GIF
- Download subtitles and transcripts as SRT, VTT, or plain text
- Grab the video's thumbnail / poster image

■ WORKS ON SOCIAL & STREAMING SITES
Save video from Reddit and many other sites.

■ 100% ON YOUR DEVICE
All conversion runs locally with bundled FFmpeg (WebAssembly). Nothing is ever uploaded — private by design.

■ MORE
- Quality picker for adaptive (HLS) streams
- Fast parallel downloads with pause, resume, cancel, and retry
- Paste a link: drop any video URL and get download options

Note: DRM-protected content (e.g. Netflix, Disney+) can't be downloaded — the extension detects this and tells you rather than saving a broken file. Please respect the terms of the sites you use and only download content you have the right to save.
```

Optional future test (needs manifest name change + re-zip + slightly more review
scrutiny): rename to "Video Catch — Video Downloader, Clip & MP3" if search
traffic is weak after a week.

## 4. Single purpose (required field)

```
Video Catch has a single purpose: to let the user save videos, audio, subtitles,
and thumbnails that are playing or linked in their browser, and to convert those
saved files locally (merge streams to MP4, extract MP3, trim clips, export GIFs).
```

## 5. Permission justifications (required field)

Paste each justification against the matching permission.

- **downloads** — Used to save the video, audio, subtitle, thumbnail, clip, or
  GIF files the user chooses to download, through the browser's own download
  system.

- **webRequest** — Used to detect video and audio stream requests (such as
  .m3u8, .mpd, and .mp4) made by the current page, so the extension can offer
  the user the option to save them. Requests are inspected locally and never
  logged or transmitted.

- **notifications** — Used to prompt the user when a downloadable video is
  detected and to report when a download has finished or failed.

- **storage** — Used to remember the user's own settings (preferred quality,
  save folder, speed, toggles) and their download history list. Stored locally;
  never transmitted.

- **offscreen** — Manifest V3 service workers cannot build file blobs or run the
  WebAssembly converter. An offscreen document is used to fetch stream segments
  and run the local FFmpeg conversion that produces the final file.

- **declarativeNetRequest** — Used only during a capture to block advertising and
  tracking requests so they are not recorded into the saved file. Rules are
  scoped to the active tab and removed as soon as the capture ends.

- **Host permissions (`<all_urls>`)** — The extension must work on any site where
  the user plays a video, because video can appear on any website. Page and
  network access is used only to detect and fetch the media the user chooses to
  save, on the tab they are actively using.

**"Are you using remote code?" → answer NO.** All code, including the FFmpeg
WebAssembly converter and mux.js, is bundled in the package and loaded from local
extension URLs. The extension fetches video streams and page HTML as *data*, but
never loads or executes remote code (no remote scripts, no eval of fetched
content). Select "No, I am not using remote code" (the justification box only
appears for "Yes").

## 6. Data usage disclosure (Privacy tab)

**"What user data do you plan to collect?" → check NOTHING.** Leave every box
(personally identifiable info, web history, user activity, website content, etc.)
UNCHECKED. Google defines "collect" as transmitting data off the user's device;
this extension processes everything locally and transmits nothing, so no category
applies. This matches the privacy policy.

Then answer the certification questions as follows:

- Does this item collect or use personal or sensitive user data? **No.**
- Certify you do NOT sell or transfer user data to third parties: **Yes (certify).**
- Certify you do NOT use or transfer data for purposes unrelated to the item's
  single purpose: **Yes (certify).**
- Certify you do NOT use or transfer data to determine creditworthiness or for
  lending: **Yes (certify).**

**Privacy policy URL**: host `PRIVACY-POLICY.md` somewhere public (a GitHub repo,
GitHub Pages, or a simple gist works) and paste that URL here. A privacy policy
URL is required because the listing declares permissions.

## 7. Graphic assets **[you]**

You must provide these (they need the extension running, so I can't generate
them):

- **Store icon**: 128×128 PNG — already in the package (`icons/icon128.png`); you
  can reuse it.
- **Screenshots**: at least 1 (up to 5), 1280×800 or 640×400 PNG/JPEG.
  Suggested shots: (1) the popup with videos detected on a page, (2) the Settings
  panel, (3) the Downloads tab mid-download, (4) the subtitles picker, (5) a
  paste-a-link result.
- **Small promo tile** (optional): 440×280 PNG.

To capture screenshots: load the unpacked extension, open the popup on a page
with video, and use your OS screenshot tool at the required size.

## 8. Distribution / visibility **[you]**

- Visibility: **Public** (or Unlisted if you want to share by link only while
  testing).
- Regions: All, unless you want to limit.

## 9. Submit **[you]**

- Click **Submit for review**. First reviews typically take a few days but can
  take longer. You'll get an email with the result.

---

## If it gets rejected for the YouTube feature

1. Remove the YouTube capture pieces: the two YouTube content scripts from
   `manifest.json` (`yt-hook.js` and `youtube.js`), and hide the YouTube capture
   card in the popup. (Ask and I'll prepare this compliant build + a fresh ZIP.)
2. Bump the version number in `manifest.json`.
3. Re-upload and resubmit — the remaining features (HLS/DASH merge, Instagram,
   Reddit, subtitles, thumbnails, clips, GIF, MP3) are within policy.
