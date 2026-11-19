// Unit test for the "Paste a link" page scraper (extractMediaFromHtml).
// Mirrors the implementation in background.js and runs it against representative
// real-world HTML patterns so we don't need the loaded extension to validate it.

let idc = 0;
function mkEntry(url, type, tabId, meta = {}) {
  return { id: `paste-${idc++}`, tabId: tabId == null ? -1 : tabId, type, source: "paste", url, title: meta.title || null, size: meta.size || null };
}
function rankEntry(e) {
  return e.type === "hls" ? 3 : e.type === "dash" ? 2 : 1;
}

function extractMediaFromHtml(html, baseUrl, tabId) {
  const found = new Map();
  const abs = (s) => {
    try {
      return new URL(
        (s || "").replace(/&amp;/g, "&").replace(/\\\//g, "/").replace(/\\+$/, "").trim(),
        baseUrl
      ).href;
    } catch {
      return null;
    }
  };
  const add = (raw, type) => {
    const url = abs(raw);
    if (!url || !/^https?:/i.test(url) || url.startsWith("data:")) return;
    if (!found.has(url) || rankEntry({ type }) > rankEntry({ type: found.get(url) })) found.set(url, type);
  };
  let m;
  const metaA = /<meta[^>]+(?:property|name)=["'](?:og:video(?::(?:url|secure_url))?|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi;
  while ((m = metaA.exec(html))) add(m[1], /\.m3u8/i.test(m[1]) ? "hls" : "video");
  const metaB = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video(?::(?:url|secure_url))?|twitter:player:stream)["']/gi;
  while ((m = metaB.exec(html))) add(m[1], /\.m3u8/i.test(m[1]) ? "hls" : "video");
  const srcRe = /<(?:video|source)[^>]+src=["']([^"']+)["']/gi;
  while ((m = srcRe.exec(html))) {
    const u = m[1];
    add(u, /\.m3u8/i.test(u) ? "hls" : /\.mpd/i.test(u) ? "dash" : "video");
  }
  const jsonKeyRe =
    /"(?:contenturl|video_url|videourl|playbackurl|playback_url|hlsurl|hls_url|hlsmanifesturl|dashurl|dash_url|manifesturl|streamurl|stream_url|playurl|play_url|downloadurl|download_url|src|file|url)"\s*:\s*"([^"]+?\.(?:m3u8|mpd|mp4|webm|m4v|mov)(?:\\?[?#][^"]*)?)"/gi;
  while ((m = jsonKeyRe.exec(html))) {
    const u = m[1];
    add(u, /\.m3u8/i.test(u) ? "hls" : /\.mpd/i.test(u) ? "dash" : "video");
  }
  const bareRe = /https?:\\?\/\\?\/[^\s"'<>]+?\.(m3u8|mpd|mp4|webm|m4v|mov)(?:[?#][^\s"'<>]*)?/gi;
  while ((m = bareRe.exec(html))) {
    const ext = m[1].toLowerCase();
    add(m[0], ext === "m3u8" ? "hls" : ext === "mpd" ? "dash" : "video");
  }
  const items = [...found].map(([url, type]) => mkEntry(url, type, tabId, {}));
  items.sort((a, b) => rankEntry(b) - rankEntry(a));
  return items.slice(0, 8);
}

let pass = 0, fail = 0;
function check(name, html, base, expect) {
  idc = 0;
  const items = extractMediaFromHtml(html, base, -1);
  const urls = items.map((i) => `${i.type}:${i.url}`);
  const ok = expect.every((e) => urls.some((u) => u.includes(e)));
  if (ok) { pass++; console.log(`  ok  ${name} -> [${urls.join(", ")}]`); }
  else { fail++; console.log(`FAIL  ${name}\n      got:    ${JSON.stringify(urls)}\n      expect: ${JSON.stringify(expect)}`); }
}

// 1. og:video meta (Open Graph — used by most social/video sites)
check("og:video", `<meta property="og:video" content="https://cdn.site.com/v/abc.mp4" />`, "https://site.com/p", ["video:https://cdn.site.com/v/abc.mp4"]);

// 2. og:video:secure_url with content-before-property ordering
check("og:video:secure_url reversed", `<meta content="https://cdn.site.com/s.mp4" property="og:video:secure_url">`, "https://site.com", ["video:https://cdn.site.com/s.mp4"]);

// 3. <video><source> with relative URL → resolved against base
check("<source> relative", `<video><source src="/media/clip.webm" type="video/webm"></video>`, "https://ex.com/watch/5", ["video:https://ex.com/media/clip.webm"]);

// 4. HLS m3u8 inside a JSON blob with escaped slashes (very common)
check("escaped m3u8 in JSON", `<script>var c={"hls":"https:\\/\\/v.cdn.com\\/playlist.m3u8?token=xyz"};</script>`, "https://ex.com", ["hls:https://v.cdn.com/playlist.m3u8"]);

// 5. JSON-LD contentUrl (news sites / schema.org VideoObject)
check("JSON-LD contentUrl", `<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://m.news.com/a.mp4"}</script>`, "https://news.com", ["video:https://m.news.com/a.mp4"]);

// 6. twitter:player:stream
check("twitter player stream", `<meta name="twitter:player:stream" content="https://t.co/v/stream.mp4">`, "https://x.com", ["video:https://t.co/v/stream.mp4"]);

// 7. bare mp4 url in a script with query string
check("bare mp4 with query", `<script>player.load("https://cdn.x.com/path/file.mp4?sig=abc&exp=99");</script>`, "https://x.com", ["video:https://cdn.x.com/path/file.mp4?sig=abc"]);

// 8. dash mpd in <source>
check("dash source", `<source src="https://cdn.x.com/manifest.mpd" type="application/dash+xml">`, "https://x.com", ["dash:https://cdn.x.com/manifest.mpd"]);

// 9. dedup + ranking: same video appears as og + bare; hls ranked first
check("dedup + rank", `<meta property="og:video" content="https://c.com/a.mp4"><script>"https:\\/\\/c.com\\/master.m3u8"</script><video src="https://c.com/a.mp4"></video>`, "https://c.com", ["hls:https://c.com/master.m3u8", "video:https://c.com/a.mp4"]);

// 11. Instagram-style "video_url" with escaped slashes
check("instagram video_url", `<script>{"video_url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/clip.mp4?efg=abc&_nc=1"}</script>`, "https://instagram.com", ["video:https://scontent.cdninstagram.com/v/clip.mp4?efg=abc"]);

// 12. player "playbackUrl" pointing at an HLS manifest
check("playbackUrl hls", `var cfg={"playbackUrl":"https://cdn.lms.com/lecture/master.m3u8?token=t"};`, "https://lms.com", ["hls:https://cdn.lms.com/lecture/master.m3u8?token=t"]);

// 10. no false positive on data: URIs
idc = 0;
const noneItems = extractMediaFromHtml(`<video src="data:video/mp4;base64,AAAA"></video><img src="x.png">`, "https://x.com", -1);
if (noneItems.length === 0) { pass++; console.log("  ok  ignores data: + non-video"); }
else { fail++; console.log(`FAIL  ignores data: -> ${JSON.stringify(noneItems.map(i=>i.url))}`); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
