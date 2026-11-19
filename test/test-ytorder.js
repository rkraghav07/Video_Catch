// Tests the YouTube capture reassembly algorithm: decodeTimeOf lives in
// yt-hook.js (tags each streamed fragment with its tfdt ticks) and the
// sort/de-dup now lives in offscreen.js (orderedIndex). Browser files can't be
// vm-loaded, so we mirror the exact algorithm here and run it against synthetic
// fMP4 fragments with known `tfdt` (baseMediaDecodeTime) boxes — verifying the
// parse offsets, byte order, sort, and de-dup that turn out-of-order/mid-video
// captures into a clean stream.

// --- algorithm under test (mirror of yt-hook.js) ---
function decodeTimeOf(u8) {
  const limit = Math.min(u8.length - 12, 600);
  for (let i = 0; i < limit; i++) {
    if (u8[i] === 0x74 && u8[i + 1] === 0x66 && u8[i + 2] === 0x64 && u8[i + 3] === 0x74) {
      const version = u8[i + 4];
      const p = i + 8;
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
function orderedChunks(chunks) {
  const tagged = chunks.map((c, i) => ({ c, i, t: decodeTimeOf(c) }));
  const withT = tagged.filter((x) => x.t != null).length;
  if (withT < tagged.length * 0.6) return chunks;
  tagged.sort((a, b) => (a.t == null ? Infinity : a.t) - (b.t == null ? Infinity : b.t) || a.i - b.i);
  const out = [];
  let lastT = NaN;
  let lastSize = -1;
  for (const x of tagged) {
    if (x.t != null && x.t === lastT && x.c.byteLength === lastSize) continue;
    out.push(x.c);
    lastT = x.t == null ? NaN : x.t;
    lastSize = x.c.byteLength;
  }
  return out;
}

// --- helpers to build synthetic fragments ---
// A fragment = a few junk bytes (fake moof header) + a tfdt box + some padding (fake
// mdat). `tag` byte lets us identify which fragment we got back.
function frag(decodeTime, version = 0, pad = 20) {
  const tfdtLen = version === 1 ? 20 : 16;
  const bytes = [];
  bytes.push(0, 0, 0, 0x18, 0x6d, 0x6f, 0x6f, 0x66); // fake 'moof' box header (ignored)
  // tfdt box
  bytes.push(0, 0, 0, tfdtLen, 0x74, 0x66, 0x64, 0x74, version, 0, 0, 0);
  if (version === 1) {
    bytes.push((decodeTime / 0x100000000) & 0xff, 0, 0, 0); // hi (small values → mostly 0)
    bytes.push((decodeTime >>> 24) & 0xff, (decodeTime >>> 16) & 0xff, (decodeTime >>> 8) & 0xff, decodeTime & 0xff);
  } else {
    bytes.push((decodeTime >>> 24) & 0xff, (decodeTime >>> 16) & 0xff, (decodeTime >>> 8) & 0xff, decodeTime & 0xff);
  }
  for (let i = 0; i < pad; i++) bytes.push(0);
  return new Uint8Array(bytes);
}
const times = (arr) => arr.map(decodeTimeOf);

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`); }
};

// --- parse ---
check("decodeTimeOf reads v0 baseMediaDecodeTime", decodeTimeOf(frag(123456)) === 123456);
check("decodeTimeOf reads a big v0 value", decodeTimeOf(frag(2000000000)) === 2000000000);
check("decodeTimeOf reads v1 (64-bit) value", decodeTimeOf(frag(5000000, 1)) === 5000000);
check("decodeTimeOf returns null when no tfdt", decodeTimeOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])) === null);

// --- the mid-video case: watched region captured, then play-through backfills 0→pos.
// Append order is out of order; after ordering it must be clean ascending by time.
const mid = [frag(500), frag(600), frag(0), frag(100), frag(200), frag(700), frag(800)];
check(
  "mid-video: reassembled 0→end in ascending order",
  times(orderedChunks(mid)).join(",") === "0,100,200,500,600,700,800",
  times(orderedChunks(mid)).join(",")
);

// --- de-dup: a segment re-fetched on a seek (same time AND size) collapses to one
const dup = [frag(0), frag(100), frag(100), frag(200)];
check("de-dups an exact re-fetch (same time+size)", times(orderedChunks(dup)).join(",") === "0,100,200", times(orderedChunks(dup)).join(","));

// --- distinct fragments that happen to share a decode time but differ in size are BOTH kept
const sameTimeDiffSize = [frag(0, 0, 20), frag(50, 0, 10), frag(50, 0, 30)];
check("keeps distinct fragments with same time but different size", orderedChunks(sameTimeDiffSize).length === 3);

// --- fallback: if <60% carry a tfdt, keep the original append order untouched
const mostlyNoTfdt = [new Uint8Array([9, 9, 9, 9]), new Uint8Array([8, 8, 8, 8]), frag(0)];
check("falls back to append order when tfdt coverage is low", orderedChunks(mostlyNoTfdt).length === 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
