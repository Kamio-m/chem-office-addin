// 生成 manifest 所需的加载项图标（无需任何外部依赖）
// 用法: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../public/assets");

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TEAL = [13, 148, 136];
const WHITE = [255, 255, 255];

function inRoundedRect(x, y, size, radius) {
  const half = size / 2;
  const qx = Math.abs(x - half) - (half - radius);
  const qy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius <= 0;
}

function hexRadiusAt(theta, R) {
  const step = Math.PI / 3;
  const a = ((theta % step) + step) % step;
  return (R * Math.cos(Math.PI / 6)) / Math.cos(a - Math.PI / 6);
}

function render(size) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const bgRadius = size * 0.22;
  const hexR = size * 0.35;
  const ringW = size * 0.1;
  const dotR = size * 0.088;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (!inRoundedRect(x, y, size, bgRadius)) continue;
          const dx = x - half;
          const dy = y - half;
          const dist = Math.hypot(dx, dy);
          const theta = Math.atan2(dy, dx);
          const boundary = hexRadiusAt(theta, hexR);
          const isRing = Math.abs(dist - boundary) <= ringW / 2;
          const isDot = dist <= dotR;
          const c = isRing || isDot ? WHITE : TEAL;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
      const n = SS * SS;
      const idx = (py * size + px) * 4;
      const alpha = a / n;
      const covered = a / 255;
      buf[idx] = covered ? Math.round(r / covered) : 0;
      buf[idx + 1] = covered ? Math.round(g / covered) : 0;
      buf[idx + 2] = covered ? Math.round(b / covered) : 0;
      buf[idx + 3] = Math.round(alpha);
    }
  }
  return encodePng(size, size, buf);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 80]) {
  const png = render(size);
  const file = resolve(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log("written", file, png.length, "bytes");
}
