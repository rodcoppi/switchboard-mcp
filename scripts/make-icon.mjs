// Regenerates assets/switchboard.ico — the icon Windows shows on the Desktop
// shortcut (a .bat cannot carry one; the .lnk points its IconLocation here).
//
// Why a generator instead of a committed blob from some design tool: the repo
// has no build step and no image dependency, and a binary with no provenance is
// unmaintainable — nobody can answer "what shade of amber is that". The mark is
// the product's thesis (two patchbay jacks joined by a patch cable) in the
// dashboard's own palette, and it is parametric, so every size is DRAWN at its
// own resolution rather than downscaled from 256 (which turns the 16px cable
// into grey mush).
//
// Usage: node scripts/make-icon.mjs
// PNG-inside-ICO is Vista+; the target here is Windows 10/11 (README: WSL).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

// -- palette: the dashboard's own tokens (public/index.html :root) -----------
const BG = [0x0e, 0x14, 0x1d]; // console body
const HOLE = [0x07, 0x0b, 0x10]; // --bg-inset, the jack's throat
const AMBER = [0xf5, 0xa6, 0x23]; // --accent
const AMBER_HI = [0xff, 0xbf, 0x5e]; // --accent-bright, the lit jack

// -- geometry, all normalized 0..1 so every size draws itself ----------------
// The mark is "⇄" — the one the product already uses (the dashboard header and
// the README title both read "⇄ SWITCHBOARD"), so the shortcut, the favicon and
// the wordmark agree instead of each inventing a logo.
//
// Two rejected drafts, recorded so nobody re-draws them: jacks side by side over
// a sagging cable read as a SMILEY FACE; the same pair on a diagonal reads as a
// TELEPHONE HANDSET once the 16px face thins the rings away. Arrows survive the
// small sizes because they are solid mass, not outline.
const TILE_R = 0.22; // rounded-square radius
const TOP_Y = 0.385;
const BOT_Y = 0.615;
const X_LEFT = 0.235;
const X_RIGHT = 0.765;

/**
 * Arrow proportions are a function of the FACE SIZE, not constants: at 16px one
 * pixel is 6% of the icon, so a head sized to look right at 256 protrudes ~2px
 * past the shaft and the pair collapses into an "=" sign. The small faces get a
 * head that is deliberately out of proportion — taller and longer over a thinner
 * shaft — which is the only thing that still reads as a direction down there.
 */
function geometry(size) {
  const small = size <= 32;
  return {
    arrowR: small ? 0.05 : 0.055, // shaft half-thickness
    headH: small ? 0.17 : 0.115, // arrowhead half-height
    headLen: small ? 0.23 : 0.15,
  };
}

const SIZES = [16, 32, 48, 64, 128, 256];

// -- signed-distance helpers -------------------------------------------------
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** Distance from a point to a segment — a capsule is this, thresholded. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return dist(px, py, ax + t * dx, ay + t * dy);
}

/**
 * Inside a rounded rect spanning the unit square, corner radius r — i.e.
 * within r of the inner rect [r,1-r]². Clamping each axis at 0 first is what
 * makes the edge zones (one axis outside, one inside) count as inside; without
 * the clamp the four edges get carved away and the tile renders as a plus.
 */
function inRoundRect(px, py, r) {
  const dx = Math.max(0, Math.abs(px - 0.5) - (0.5 - r));
  const dy = Math.max(0, Math.abs(py - 0.5) - (0.5 - r));
  return dx * dx + dy * dy <= r * r;
}

/** Inside the triangle abc (same-sign cross products against each edge). */
function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const s = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const t = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  if (s < 0 !== t < 0 && s !== 0 && t !== 0) return false;
  const d = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  return d === 0 || d < 0 === s + t <= 0;
}

/**
 * One arrow: a shaft capsule plus a solid head. `dir` is +1 (points right) or
 * -1 (points left); the shaft stops at the head's base so the two never
 * double-cover (they are the same colour, but overlap would fatten the joint).
 */
function onArrow(px, py, y, dir, geo) {
  const tip = dir > 0 ? X_RIGHT : X_LEFT;
  const base = tip - dir * geo.headLen;
  const tail = dir > 0 ? X_LEFT : X_RIGHT;
  if (distToSegment(px, py, tail, y, base, y) <= geo.arrowR) return true;
  return inTriangle(px, py, [tip, y], [base, y - geo.headH], [base, y + geo.headH]);
}

/**
 * Colour at a normalized point, or null for transparent (outside the tile).
 * The two arrows differ by one step of amber: flat-identical arrows read as a
 * single "=" at 16px, while the tonal split keeps them two lanes of traffic.
 */
function colorAt(px, py, geo) {
  if (!inRoundRect(px, py, TILE_R)) return null;
  if (onArrow(px, py, TOP_Y, +1, geo)) return AMBER_HI;
  if (onArrow(px, py, BOT_Y, -1, geo)) return AMBER;
  return BG;
}

/** Renders one size to RGBA bytes, 4×4 supersampled (the only antialiasing). */
function render(size) {
  const SS = 4;
  const geo = geometry(size);
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, geo);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          hits++;
        }
      }
      const i = (y * size + x) * 4;
      const total = SS * SS;
      if (hits === 0) continue; // transparent
      // Un-premultiply: average only the samples that landed on the tile, so
      // the rounded edge fades in alpha instead of darkening toward black.
      buf[i] = Math.round(r / hits);
      buf[i + 1] = Math.round(g / hits);
      buf[i + 2] = Math.round(b / hits);
      buf[i + 3] = Math.round((hits / total) * 255);
    }
  }
  return buf;
}

// -- minimal PNG encoder -----------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 = compression 0, filter 0, interlace 0 (already zero)

  // Filter byte 0 (None) per scanline — the shapes are flat colour, so the
  // extra work of picking filters buys nothing zlib will not find.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// -- ICO container -----------------------------------------------------------
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size; // 0 means 256 in this format
    e[1] = size === 256 ? 0 : size;
    e[2] = 0; // palette size
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

// -- main --------------------------------------------------------------------
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const images = SIZES.map((size) => ({ size, png: encodePng(render(size), size) }));
const ico = buildIco(images);
const out = path.join(root, "assets", "switchboard.ico");
fs.writeFileSync(out, ico);
console.log(`${path.relative(root, out)} — ${SIZES.join("/")} px, ${ico.length} bytes`);

// A PNG of the 256 face too: READMEs and the web cannot render .ico.
const png256 = path.join(root, "assets", "switchboard.png");
fs.writeFileSync(png256, images[images.length - 1].png);
console.log(`${path.relative(root, png256)} — 256 px, ${images[images.length - 1].png.length} bytes`);
