/**
 * Zero-dependency PNG icon generator (128×128 RGBA).
 *
 * Produces media/icon.png — a blue rounded-square with a white chat-bubble
 * mark, used as the Marketplace icon (package.json "icon") and the webview
 * brand header. Run after changing the design:
 *
 *   node --import tsx/esm scripts/gen-icon.ts
 *
 * Uses only node:zlib + a hand-rolled PNG chunk writer — no native deps.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 128

// ─── pixel canvas ────────────────────────────────────────────────────────────
type RGBA = [number, number, number, number]
const buf = Buffer.alloc(SIZE * SIZE * 4)

function px(x: number, y: number, c: RGBA): void {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  // alpha-blend over existing
  const sa = c[3] / 255
  const da = buf.readUInt8(i + 3) / 255
  const oa = sa + da * (1 - sa)
  if (oa === 0) return
  const dr = buf.readUInt8(i), dg = buf.readUInt8(i + 1), db = buf.readUInt8(i + 2)
  buf[i] = Math.round((c[0] * sa + dr * da * (1 - sa)) / oa)
  buf[i + 1] = Math.round((c[1] * sa + dg * da * (1 - sa)) / oa)
  buf[i + 2] = Math.round((c[2] * sa + db * da * (1 - sa)) / oa)
  buf[i + 3] = Math.round(oa * 255)
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGBA): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(x, y, c)
}

/** Fill a rounded rectangle (anti-aliased corners via radius check). */
function fillRound(x0: number, y0: number, x1: number, y1: number, r: number, c: RGBA): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      // distance from nearest corner
      let dx = 0, dy = 0
      if (x < x0 + r) dx = x0 + r - x
      else if (x >= x1 - r) dx = x - (x1 - r - 1)
      if (y < y0 + r) dy = y0 + r - y
      else if (y >= y1 - r) dy = y - (y1 - r - 1)
      if (dx > 0 && dy > 0) {
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d <= r) px(x, y, c)
        else if (d < r + 1) { const a = Math.round(c[3] * (r + 1 - d)); px(x, y, [c[0], c[1], c[2], a]) }
      } else {
        px(x, y, c)
      }
    }
  }
}

// ─── design ──────────────────────────────────────────────────────────────────
const BLUE: RGBA = [61, 104, 255, 255]       // #3D68FF — DeepSeek-ish blue
const BLUE_DARK: RGBA = [41, 72, 200, 255]   // gradient bottom
const WHITE: RGBA = [255, 255, 255, 255]
const WHITE_80: RGBA = [255, 255, 255, 210]

// 1. Rounded-square background with a vertical gradient.
for (let y = 0; y < SIZE; y++) {
  const t = y / SIZE
  const r = Math.round(BLUE[0] + (BLUE_DARK[0] - BLUE[0]) * t)
  const g = Math.round(BLUE[1] + (BLUE_DARK[1] - BLUE[1]) * t)
  const b = Math.round(BLUE[2] + (BLUE_DARK[2] - BLUE[2]) * t)
  for (let x = 0; x < SIZE; x++) {
    // rounded corners: radius 24
    const rad = 24
    let dx = 0, dy = 0
    if (x < rad) dx = rad - x; else if (x >= SIZE - rad) dx = x - (SIZE - rad - 1)
    if (y < rad) dy = rad - y; else if (y >= SIZE - rad) dy = y - (SIZE - rad - 1)
    if (dx > 0 && dy > 0) {
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d <= rad) px(x, y, [r, g, b, 255])
      else if (d < rad + 1) { const a = Math.round(255 * (rad + 1 - d)); px(x, y, [r, g, b, a]) }
    } else {
      px(x, y, [r, g, b, 255])
    }
  }
}

// 2. White chat-bubble (rounded rect + tail) in the center.
const bx0 = 30, by0 = 34, bx1 = 98, by1 = 84, br = 12
fillRound(bx0, by0, bx1, by1, br, WHITE)
// tail (triangle pointing down-left)
for (let y = by1 - 2; y < by1 + 16; y++) {
  const w = Math.max(0, 16 - (y - (by1 - 2)))
  for (let x = bx0 + 12; x < bx0 + 12 + w; x++) px(x, y, WHITE)
}

// 3. Three text lines inside the bubble (blue, to contrast on white).
const LINE: RGBA = [BLUE[0] - 20, BLUE[1] - 20, BLUE[2] - 20, 255]
const lines = [
  { y: 48, x0: 42, x1: 86, h: 5 },
  { y: 58, x0: 42, x1: 74, h: 5 },
  { y: 68, x0: 42, x1: 80, h: 5 },
]
for (const l of lines) fillRect(l.x0, l.y, l.x1, l.y + l.h, LINE)

// ─── PNG encode ──────────────────────────────────────────────────────────────
// Pre-computed CRC32 table (PNG chunk checksums).
const CRC_TABLE: number[] = (() => {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)   // width
ihdr.writeUInt32BE(SIZE, 4)   // height
ihdr[8] = 8                    // bit depth
ihdr[9] = 6                    // color type RGBA
ihdr[10] = 0                   // compression
ihdr[11] = 0                   // filter
ihdr[12] = 0                   // interlace

// Raw scanlines: each row prefixed with filter byte 0.
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}
const idat = deflateSync(raw, { level: 9 })

const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'icon.png')
writeFileSync(out, png)
console.log(`wrote ${out} (${png.length} bytes, ${SIZE}×${SIZE} RGBA)`)
