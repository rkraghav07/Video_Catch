// Verifies the vendored ffmpeg.wasm core supports the operations Video Catch
// uses (remux, MP3, GIF), against a real public HLS test stream.
// Logs lines prefixed VCTEST: so they're easy to read from the console.

const TEST_HLS = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
const results = document.getElementById("results");
const outputs = document.getElementById("outputs");
const summary = {};

function log(msg) {
  console.log("VCTEST:", msg);
}
function row(name, status, detail) {
  const d = document.createElement("div");
  d.className = "row " + status;
  d.innerHTML = `<b>${name}</b>: ${status.toUpperCase()}${detail ? " — " + detail : ""}`;
  results.appendChild(d);
  log(`${name} = ${status}${detail ? " (" + detail + ")" : ""}`);
  summary[name] = { status, detail };
}

async function fetchText(u) {
  const r = await fetch(u);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}
async function fetchBuf(u) {
  const r = await fetch(u);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

function parseVariants(text, base) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const bw = (/BANDWIDTH=(\d+)/.exec(lines[i]) || [])[1];
      const uri = lines[i + 1] && !lines[i + 1].startsWith("#") ? lines[i + 1].trim() : null;
      if (uri) out.push({ bw: +bw || 0, url: new URL(uri, base).href });
    }
  }
  return out.sort((a, b) => a.bw - b.bw); // ascending; pick smallest for speed
}
function parseSegments(text, base) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new URL(l, base).href);
}

(async () => {
  let ff;
  try {
    row("ffmpeg.load", "pending", "compiling wasm…");
    const { FFmpeg } = self.FFmpegWASM;
    ff = new FFmpeg();
    const logs = [];
    ff.on("log", ({ message }) => logs.push(message));
    await ff.load({
      coreURL: "/vendor/ffmpeg/ffmpeg-core.js",
      wasmURL: "/vendor/ffmpeg/ffmpeg-core.wasm",
    });
    results.lastChild.remove();
    row("ffmpeg.load", "ok", "core loaded");
    window.__ffLogs = logs;
  } catch (e) {
    row("ffmpeg.load", "fail", String(e));
    finish();
    return;
  }

  // --- fetch a few real .ts segments ---
  let tsBytes;
  try {
    const master = await fetchText(TEST_HLS);
    const variants = parseVariants(master, TEST_HLS);
    const variantUrl = variants.length ? variants[0].url : TEST_HLS;
    const media = await fetchText(variantUrl);
    const segs = parseSegments(media, variantUrl).slice(0, 3);
    const parts = [];
    for (const s of segs) parts.push(await fetchBuf(s));
    tsBytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    row("fetch HLS segments", "ok", `${segs.length} segs, ${(tsBytes.length / 1e6).toFixed(2)} MB`);
  } catch (e) {
    row("fetch HLS segments", "fail", String(e));
    finish();
    return;
  }

  // --- remux .ts -> .mp4 (-c copy) ---
  let mp4Bytes;
  try {
    await ff.writeFile("in.ts", tsBytes);
    await ff.exec(["-i", "in.ts", "-c", "copy", "-movflags", "+faststart", "out.mp4"]);
    mp4Bytes = await ff.readFile("out.mp4");
    if (!mp4Bytes.length) throw new Error("empty output");
    row("remux ts→mp4", "ok", `${(mp4Bytes.length / 1e6).toFixed(2)} MB`);
    const v = document.createElement("video");
    v.controls = true;
    v.src = URL.createObjectURL(new Blob([mp4Bytes], { type: "video/mp4" }));
    outputs.appendChild(v);
  } catch (e) {
    row("remux ts→mp4", "fail", String(e));
  }

  const src = mp4Bytes && mp4Bytes.length ? { name: "src.mp4", bytes: mp4Bytes } : { name: "in.ts", bytes: tsBytes };
  if (src.name === "src.mp4") await ff.writeFile("src.mp4", mp4Bytes);

  // --- MP3 (libmp3lame) ---
  try {
    await ff.exec(["-i", src.name, "-vn", "-c:a", "libmp3lame", "-q:a", "2", "a.mp3"]);
    const mp3 = await ff.readFile("a.mp3");
    if (!mp3.length) throw new Error("empty");
    row("audio→mp3 (libmp3lame)", "ok", `${(mp3.length / 1e3).toFixed(0)} KB`);
    const a = document.createElement("audio");
    a.controls = true;
    a.src = URL.createObjectURL(new Blob([mp3], { type: "audio/mpeg" }));
    outputs.appendChild(a);
  } catch (e) {
    row("audio→mp3 (libmp3lame)", "fail", String(e).slice(0, 120));
  }

  // --- audio copy -> m4a (fallback path) ---
  try {
    await ff.exec(["-i", src.name, "-vn", "-c:a", "copy", "a.m4a"]);
    const m4a = await ff.readFile("a.m4a");
    if (!m4a.length) throw new Error("empty");
    row("audio→m4a (copy fallback)", "ok", `${(m4a.length / 1e3).toFixed(0)} KB`);
  } catch (e) {
    row("audio→m4a (copy fallback)", "fail", String(e).slice(0, 120));
  }

  // --- GIF ---
  try {
    await ff.exec([
      "-ss", "0", "-t", "2", "-i", src.name,
      "-vf", "fps=10,scale=320:-1:flags=lanczos", "-loop", "0", "out.gif",
    ]);
    const gif = await ff.readFile("out.gif");
    if (!gif.length) throw new Error("empty");
    row("gif export", "ok", `${(gif.length / 1e3).toFixed(0)} KB`);
    const img = document.createElement("img");
    img.src = URL.createObjectURL(new Blob([gif], { type: "image/gif" }));
    outputs.appendChild(img);
  } catch (e) {
    row("gif export", "fail", String(e).slice(0, 120));
  }

  // --- clip (-ss -to -c copy) ---
  try {
    await ff.exec(["-ss", "0", "-to", "2", "-i", src.name, "-c", "copy", "clip.mp4"]);
    const clip = await ff.readFile("clip.mp4");
    if (!clip.length) throw new Error("empty");
    row("clip/trim (copy)", "ok", `${(clip.length / 1e3).toFixed(0)} KB`);
  } catch (e) {
    row("clip/trim (copy)", "fail", String(e).slice(0, 120));
  }

  finish();
})();

function finish() {
  log("SUMMARY " + JSON.stringify(summary));
  const d = document.createElement("div");
  d.className = "row";
  d.innerHTML = "<b>DONE</b> — verification complete.";
  results.appendChild(d);
  window.__VCTEST_DONE = true;
}
