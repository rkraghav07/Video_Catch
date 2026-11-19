// Tests X/Twitter media-id correlation: the numeric tweet media id must be
// extractable from BOTH the HLS stream URL and the video's poster thumbnail, so
// the extension can (a) name each sniffed stream after its own tweet and (b) let
// the Catch button map a hovered video to exactly its stream. Mirrors xMediaId()
// (identical in content.js and background.js).

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

function xMediaId(url) {
  const m = /(?:amplify_video|ext_tw_video|tweet_video)(?:_thumb)?\/(\d+)/i.exec(url || "");
  return m ? m[1] : null;
}

// --- extraction from every twimg URL shape --------------------------------
check("amplify HLS", xMediaId("https://video.twimg.com/amplify_video/1799999999999999999/pl/a.m3u8") === "1799999999999999999");
check("ext_tw HLS", xMediaId("https://video.twimg.com/ext_tw_video/1712345678901234567/pu/pl/x.m3u8") === "1712345678901234567");
check("amplify poster thumb", xMediaId("https://pbs.twimg.com/amplify_video_thumb/1799999999999999999/img/a.jpg") === "1799999999999999999");
check("ext_tw poster thumb", xMediaId("https://pbs.twimg.com/ext_tw_video_thumb/1712345678901234567/pu/img/x.jpg") === "1712345678901234567");
check("amplify segment (same id)", xMediaId("https://video.twimg.com/amplify_video/1799999999999999999/vid/720x1280/abc.ts") === "1799999999999999999");
check("non-twimg → null", xMediaId("https://x.com/home") === null);
check("empty → null", xMediaId("") === null);
check("null → null", xMediaId(null) === null);

// --- correlation: the whole point ------------------------------------------
const tweetA = {
  hls: "https://video.twimg.com/amplify_video/1799999999999999999/pl/a.m3u8",
  poster: "https://pbs.twimg.com/amplify_video_thumb/1799999999999999999/img/a.jpg",
};
const tweetB = {
  hls: "https://video.twimg.com/ext_tw_video/1712345678901234567/pu/pl/b.m3u8",
  poster: "https://pbs.twimg.com/ext_tw_video_thumb/1712345678901234567/pu/img/b.jpg",
};
check("tweet A: poster id == stream id", xMediaId(tweetA.hls) === xMediaId(tweetA.poster));
check("tweet B: poster id == stream id", xMediaId(tweetB.hls) === xMediaId(tweetB.poster));
check("different tweets → different ids", xMediaId(tweetA.hls) !== xMediaId(tweetB.hls));

// --- the naming map (mirror of noteXTitle/xTitleFor logic) ------------------
// Given id→title from the page, a sniffed stream URL resolves to the right title.
const titles = new Map([[xMediaId(tweetA.hls), "OnePlus India - An x-tra good-looking addition"]]);
const titleFor = (url) => titles.get(xMediaId(url)) || null;
check("stream A resolves to tweet A's title", titleFor(tweetA.hls) === "OnePlus India - An x-tra good-looking addition");
check("stream B (no mapping yet) → null, not A's title", titleFor(tweetB.hls) === null);

// --- backfill guard: only replace a generic page title, not a real one ------
const isGeneric = (t, pageTitle) => !t || / \/ X$| \/ Twitter$/i.test(t) || t === pageTitle;
check("replaces '(2) Home / X'", isGeneric("(2) Home / X", "(2) Home / X"));
check("replaces bare '… / Twitter'", isGeneric("Something / Twitter"));
check("keeps a real tweet title", !isGeneric("OnePlus India - An x-tra good-looking addition", "(2) Home / X"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
