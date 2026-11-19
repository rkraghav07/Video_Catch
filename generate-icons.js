// Generates icon16/48/128.png — a blue rounded square with a white download arrow.
// Run with: node generate-icons.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function isArrow(x, y, size) {
  const nx = x / size;
  const ny = y / size;
  const cx = 0.5;
  // shaft
  if (nx > 0.42 && nx < 0.58 && ny > 0.2 && ny < 0.52) return true;
  // arrowhead (triangle pointing down)
  if (ny >= 0.52 && ny < 0.7) {
    const hw = 0.24 * (1 - (ny - 0.52) / 0.18);
    if (nx > cx - hw && nx < cx + hw) return true;
  }
  // tray bar
  if (nx > 0.26 && nx < 0.74 && ny > 0.76 && ny < 0.84) return true;
  return false;
}

function rounded(x, y, size) {
  const r = size * 0.18;
  const inX = x < r ? r - x : x > size - r ? x - (size - r) : 0;
  const inY = y < r ? r - y : y > size - r ? y - (size - r) : 0;
  return Math.sqrt(inX * inX + inY * inY) <= r;
}

function makePNG(size) {
  const bg = [37, 99, 235, 255];
  const fg = [255, 255, 255, 255];
  const clear = [0, 0, 0, 0];
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let pos = 0;
  for (let y = 0; y < size; y++) {
    raw[pos++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let c;
      if (!rounded(x, y, size)) c = clear;
      else if (isArrow(x, y, size)) c = fg;
      else c = bg;
      raw[pos++] = c[0];
      raw[pos++] = c[1];
      raw[pos++] = c[2];
      raw[pos++] = c[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, "icons");
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${size}.png`), makePNG(size));
  console.log(`wrote icons/icon${size}.png`);
}
