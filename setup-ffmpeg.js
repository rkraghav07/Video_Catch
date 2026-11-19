// Copies the ffmpeg.wasm UMD + core files from node_modules into vendor/ffmpeg/.
// Run after `npm install`:  node setup-ffmpeg.js
const fs = require("fs");
const path = require("path");

const dest = path.join(__dirname, "vendor", "ffmpeg");
fs.mkdirSync(dest, { recursive: true });

const files = [
  ["@ffmpeg/ffmpeg/dist/umd/ffmpeg.js", "ffmpeg.js"],
  ["@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js", "814.ffmpeg.js"],
  ["@ffmpeg/core/dist/umd/ffmpeg-core.js", "ffmpeg-core.js"],
  ["@ffmpeg/core/dist/umd/ffmpeg-core.wasm", "ffmpeg-core.wasm"],
];

for (const [from, to] of files) {
  const src = path.join(__dirname, "node_modules", ...from.split("/"));
  if (!fs.existsSync(src)) {
    console.error(`Missing ${src} — run "npm install" first.`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(dest, to));
  console.log(`copied ${to}`);
}
console.log("ffmpeg vendored into vendor/ffmpeg/");

// mux.js — streaming MPEG-TS -> MP4 remux (lets us convert multi-GB streams that
// won't fit in ffmpeg's ~2GB in-memory buffer).
const muxDest = path.join(__dirname, "vendor", "mux");
fs.mkdirSync(muxDest, { recursive: true });
const muxSrc = path.join(__dirname, "node_modules", "mux.js", "dist", "mux.min.js");
if (fs.existsSync(muxSrc)) {
  fs.copyFileSync(muxSrc, path.join(muxDest, "mux.js"));
  console.log("mux.js vendored into vendor/mux/");
} else {
  console.error(`Missing ${muxSrc} — run "npm install" first.`);
}
