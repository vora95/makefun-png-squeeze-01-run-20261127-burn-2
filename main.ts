// Squeeze screenshots into the smallest PNG (png-squeeze-01-run-20261127, burn entry).
//
// One program, one run over /input/i001..i008, writes /output/<id>/image.png.
// Lossless: every pixel's RGBA decodes exactly. Deterministic: fixed work only,
// no clock, no randomness, no environment input.
//
// Pipeline per image:
//   1. Decode the stored PNG (colour type 6, unfiltered) to RGBA.
//   2. Analyse it (opaque? grey? at most 256 colours? single transparent key?)
//      and build the candidate forms: palette (by count / by luminance),
//      grey / grey+alpha / RGB / RGBA, with a tRNS key where that holds.
//   3. Screen filter strategies per form (fixed 0/1/2/4, minimum-sum,
//      fewest-pairs, and brute force: each row's filter picked by its real
//      deflate cost against the 32 KiB before it), weighed by zlib level 6
//      (the kit's own screen level: level 1 ranks strategies wrong).
//   4. Compress the winner with our own optimal-parsing DEFLATE
//      (hash-chain match finding, shortest-path choice of literals and
//      matches under the block's Huffman costs, two Huffman iterations,
//      blocks split at row boundaries), and keep it only when it beats
//      zlib level 9 on the same filtered bytes. A block whose dynamic
//      Huffman lengths do not validate is written as a fixed-Huffman block
//      (never as a dynamic block carrying the fixed tables: the fixed tables
//      have 288 literal/length and 32 distance codes, so trimming them to
//      286/30 leaves an incomplete code).
//   5. Write a minimal PNG: IHDR, PLTE, tRNS, IDAT, IEND only, bit depth 8.
//
// The optimal-parsing deflate is the point: on the practice set the kit's
// own screen (palette, colour types, brute filters, zlib 6) is the scale at
// 666,667 points, zlib 9 on the brute winner is ~701,000, and the reference
// (brute filters + optimal-parsing deflate) is ~760-790,000. Beating the
// reference needs a deflate stronger than zlib, written here by hand.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- CRC-32 / Adler-32

const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------- PNG codec

const PNG_SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function pngOf(chunks: [string, Uint8Array][]): Uint8Array {
  let size = PNG_SIG.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIG, 0);
  let at = PNG_SIG.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out[at + 4] = type.charCodeAt(0);
    out[at + 5] = type.charCodeAt(1);
    out[at + 6] = type.charCodeAt(2);
    out[at + 7] = type.charCodeAt(3);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Filter one row of `cur` (stride samples, bpp bytes a pixel) against `prev`
// (the row above, or null) by filter `type` into `out`.
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

// Sum of a filtered row's bytes read as signed (-128..127), absolute.
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

type Decoded = { ok: true; width: number; height: number; rgba: Uint8Array } | { ok: false; why: string };

function decodePng(bytes: Uint8Array): Decoded {
  if (bytes.length < PNG_SIG.length) return { ok: false, why: 'short file' };
  for (let i = 0; i < PNG_SIG.length; i++) if (bytes[i] !== PNG_SIG[i]) return { ok: false, why: 'bad signature' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = PNG_SIG.length;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) return { ok: false, why: 'bytes after IEND' };
    if (at + 12 > bytes.length) return { ok: false, why: 'chunk cut short' };
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return { ok: false, why: 'chunk overruns file' };
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return { ok: false, why: type + ' CRC' };
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      if (header !== null) return { ok: false, why: 'IHDR twice' };
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
      if (data[8] !== 8 || data[12] !== 0) return { ok: false, why: 'depth/interlace' };
      if (!Object.hasOwn(CHANNELS, header.colourType)) return { ok: false, why: 'colour type' };
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else {
      return { ok: false, why: 'chunk ' + type };
    }
  }
  if (!ended || header === null || idat.length === 0) return { ok: false, why: 'missing chunk' };
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw: Uint8Array;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    return { ok: false, why: 'IDAT inflate' };
  }
  if (raw.length !== expected) return { ok: false, why: 'IDAT length' };
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return { ok: false, why: 'filter ' + ft };
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    if (palette === null) return { ok: false, why: 'palette missing' };
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return { ok: false, why: 'palette index' };
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, rgba };
}

// ---------------------------------------------------------------- Analysis

type Colour = { rgba: number[]; word: number; count: number };

function analyse(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: Colour[] | null } {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  if (many) return { opaque, grey, colours: null };
  const colours: Colour[] = [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) as number };
  });
  return { opaque, grey, colours };
}

// The one fully transparent value (grey or RGB) the image may key by tRNS
// instead of an alpha channel: every pixel opaque or that exact value at
// alpha 0, and no opaque pixel of the same value.
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

type Form = { colourType: number; bpp: number; samples: Uint8Array; plte: Uint8Array | null; trns: Uint8Array | null; filters: (number | string)[] };

function paletteForm(rgba: Uint8Array, colours: Colour[], order: string): { plte: Uint8Array; trns: Uint8Array | null; indices: Uint8Array } {
  const lum = (c: Colour): number => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return { plte, trns, indices };
}

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0]],
      ['luminance', [0, 'minsum', 'pairs', 'brute']],
    ] as [string, (number | string)[]][]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
  return forms;
}

function chunkBytes(form: Form): number {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

// ---------------------------------------------------------------- Filters

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// The raw data of `samples` (height rows of width x bpp), each row behind its
// filter byte, by `choice`: a filter type for every row, or 'minsum' (least
// signed sum), 'pairs' (fewest distinct byte pairs), or 'brute' (each row's
// filter picked by its real deflate cost against the 32 KiB before it).
function filteredData(samples: Uint8Array, width: number, height: number, bpp: number, choice: number | string): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        const dict = before.length === 0 ? undefined : Buffer.from(before.buffer, before.byteOffset, before.length);
        cost = deflateSync(trial[t], dict === undefined ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: dict }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------------------------------------------------------------- DEFLATE tables (RFC 1951)

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const LEN_CODE_OF: Int16Array = (() => {
  const t = new Int16Array(259);
  for (let l = 3; l <= 258; l++) {
    let c = 28;
    while (c > 0 && LEN_BASE[c] > l) c--;
    t[l] = c;
  }
  return t;
})();

const DIST_CODE_OF: Int16Array = (() => {
  const t = new Int16Array(32769);
  for (let d = 1; d <= 32768; d++) {
    let c = 29;
    while (c > 0 && DIST_BASE[c] > d) c--;
    t[d] = c;
  }
  return t;
})();

// For a longest match of length L, the lengths worth trying in the shortest
// path: the length-code bases at or below L, plus L itself.
const CANDIDATES: number[][] = (() => {
  const out: number[][] = [];
  for (let l = 3; l <= 258; l++) {
    const list: number[] = [];
    for (const b of LEN_BASE) if (b <= l && b >= 3) list.push(b);
    if (list[list.length - 1] !== l) list.push(l);
    out[l] = list;
  }
  return out;
})();

// Fixed Huffman code lengths (RFC 1951): literals 0-143: 8, 144-255: 9,
// 256-279: 7, 280-287: 8; distances: 5 each (32 codes).
const FIXED_LIT_LEN: Uint8Array = (() => {
  const t = new Uint8Array(288);
  for (let i = 0; i < 144; i++) t[i] = 8;
  for (let i = 144; i < 256; i++) t[i] = 9;
  for (let i = 256; i < 280; i++) t[i] = 7;
  for (let i = 280; i < 288; i++) t[i] = 8;
  return t;
})();
const FIXED_DIST_LEN: Uint8Array = new Uint8Array(32).fill(5);

// ---------------------------------------------------------------- Huffman

// Length-limited Huffman code lengths from symbol frequencies (zlib's
// gen_bitlen method: build the tree, clamp depths past maxBits, redistribute
// the overflow, then assign the longest lengths to the least frequent).
function huffmanLengths(freq: Uint32Array, maxBits: number): Uint8Array {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms: number[] = [];
  for (let s = 0; s < n; s++) if (freq[s] > 0) syms.push(s);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    lengths[(syms[0] + 1) % n] = 1;
    return lengths;
  }
  const m = syms.length;
  const weight = new Float64Array(2 * m);
  const parent = new Int32Array(2 * m).fill(-1);
  const left = new Int32Array(2 * m).fill(-1);
  const right = new Int32Array(2 * m).fill(-1);
  for (let i = 0; i < m; i++) weight[i] = freq[syms[i]];
  let nodeCount = m;
  for (let step = 0; step < m - 1; step++) {
    let a = -1;
    let b = -1;
    for (let i = 0; i < nodeCount; i++) {
      if (parent[i] !== -1) continue;
      if (a === -1 || weight[i] < weight[a]) {
        b = a;
        a = i;
      } else if (b === -1 || weight[i] < weight[b]) {
        b = i;
      }
    }
    weight[nodeCount] = weight[a] + weight[b];
    left[nodeCount] = a;
    right[nodeCount] = b;
    parent[a] = nodeCount;
    parent[b] = nodeCount;
    nodeCount++;
  }
  const root = nodeCount - 1;
  const depth = new Int32Array(nodeCount);
  const stack: number[] = [root];
  depth[root] = 0;
  while (stack.length > 0) {
    const u = stack.pop() as number;
    if (left[u] !== -1) {
      depth[left[u]] = depth[u] + 1;
      depth[right[u]] = depth[u] + 1;
      stack.push(left[u]);
      stack.push(right[u]);
    }
  }
  let maxDepth = 0;
  for (let i = 0; i < m; i++) {
    lengths[syms[i]] = depth[i];
    if (depth[i] > maxDepth) maxDepth = depth[i];
  }
  if (maxDepth <= maxBits) return lengths;
  // Clamp depths past maxBits; overflow counts the clamped codes.
  const bc = new Int32Array(maxDepth + 2);
  let overflow = 0;
  for (let i = 0; i < m; i++) {
    let d = lengths[syms[i]];
    if (d > maxBits) {
      d = maxBits;
      overflow++;
      lengths[syms[i]] = d;
    }
    bc[d]++;
  }
  do {
    let mm = maxBits - 1;
    while (bc[mm] === 0) mm--;
    bc[mm]--;
    bc[mm + 1] += 2;
    bc[maxBits]--;
    overflow -= 2;
  } while (overflow > 0);
  const order = [...syms].sort((x, y) => freq[x] - freq[y] || x - y);
  let idx = 0;
  for (let len = maxBits; len >= 1; len--) {
    for (let k = 0; k < bc[len]; k++) lengths[order[idx++]] = len;
  }
  return lengths;
}

// Canonical Huffman codes from lengths; returned codes are bit-reversed so
// they can be written least-significant-bit first.
function canonicalCodes(lengths: Uint8Array): Uint32Array {
  const n = lengths.length;
  let maxLen = 0;
  for (let s = 0; s < n; s++) if (lengths[s] > maxLen) maxLen = lengths[s];
  const blCount = new Uint32Array(maxLen + 1);
  for (let s = 0; s < n; s++) if (lengths[s] > 0) blCount[lengths[s]]++;
  const nextCode = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const rev = new Uint32Array(n);
  for (let s = 0; s < n; s++) {
    const len = lengths[s];
    if (len === 0) continue;
    let c = nextCode[len];
    nextCode[len]++;
    let r = 0;
    for (let b = 0; b < len; b++) {
      r = (r << 1) | (c & 1);
      c >>>= 1;
    }
    rev[s] = r;
  }
  return rev;
}

// A length assignment is a usable prefix code when every used symbol has a
// length within maxBits and the Kraft sum over every symbol with a length is 1.
function lengthsValid(lengths: Uint8Array, freq: Uint32Array, maxBits: number): boolean {
  let kraft = 0;
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (freq[s] > 0 && l === 0) return false;
    if (l > maxBits) return false;
    if (l > 0) kraft += 1 / 2 ** l;
  }
  return Math.abs(kraft - 1) < 1e-9;
}

// ---------------------------------------------------------------- Bit writer

class BitWriter {
  bytes: number[] = [];
  bitBuf = 0;
  bitCnt = 0;
  writeBits(value: number, count: number): void {
    this.bitBuf |= (value & ((1 << count) - 1)) << this.bitCnt;
    this.bitCnt += count;
    while (this.bitCnt >= 8) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  writeCode(revCode: number, len: number): void {
    this.writeBits(revCode, len);
  }
  alignByte(): void {
    if (this.bitCnt > 0) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

// ---------------------------------------------------------------- Match finding

const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const MAX_DIST = 32768;
const MAX_CHAIN = 128;

function hash3(d: Uint8Array, i: number): number {
  const h = (((d[i] * 256 + d[i + 1]) * 256 + d[i + 2]) * 2654435761) >>> 0;
  return (h >>> (32 - HASH_BITS)) & HASH_MASK;
}

class Matcher {
  data: Uint8Array;
  n: number;
  head = new Int32Array(HASH_SIZE).fill(-1);
  prev: Int32Array;
  inserted = 0;
  bestLen: Uint16Array;
  bestDist: Uint16Array;
  bestLenNear: Uint16Array;
  bestDistNear: Uint16Array;
  done: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
    this.n = data.length;
    this.prev = new Int32Array(this.n);
    this.bestLen = new Uint16Array(this.n);
    this.bestDist = new Uint16Array(this.n);
    this.bestLenNear = new Uint16Array(this.n);
    this.bestDistNear = new Uint16Array(this.n);
    this.done = new Uint8Array(this.n);
  }
  insertUpTo(upto: number): void {
    const d = this.data;
    const end = Math.min(upto, this.n - 2);
    for (let i = this.inserted; i < end; i++) {
      const h = hash3(d, i);
      this.prev[i] = this.head[h];
      this.head[h] = i;
    }
    if (upto > this.inserted) this.inserted = upto;
  }
  bestAt(i: number): { len: number; dist: number } {
    if (this.done[i]) return { len: this.bestLen[i], dist: this.bestDist[i], lenNear: this.bestLenNear[i], distNear: this.bestDistNear[i] };
    this.done[i] = 1;
    this.insertUpTo(i);
    let bestLen = 0;
    let bestDist = 0;
    let bestLenNear = 0;
    let bestDistNear = 0;
    if (i + 2 < this.n) {
      const d = this.data;
      const limit = Math.min(258, this.n - i);
      let cand = this.head[hash3(d, i)];
      let steps = 0;
      let chainLimit = MAX_CHAIN;
      while (cand >= 0 && steps < chainLimit) {
        const dist = i - cand;
        if (dist > MAX_DIST) break;
        let len = 0;
        while (len < limit && d[cand + len] === d[i + len]) len++;
        if (len >= 3 && dist <= 1024 && len > bestLenNear) { bestLenNear = len; bestDistNear = dist; }
        if (len >= 3 && len > bestLen) {
          bestLen = len;
          bestDist = dist;
          if (len >= 128) break;
          if (len >= 32) chainLimit = Math.min(chainLimit, steps + 16);
        }
        cand = this.prev[cand];
        steps++;
      }
    }
    this.bestLen[i] = bestLen;
    this.bestDist[i] = bestDist;
    this.bestLenNear[i] = bestLenNear;
    this.bestDistNear[i] = bestDistNear;
    return { len: bestLen, dist: bestDist, lenNear: bestLenNear, distNear: bestDistNear };
  }
}

// ---------------------------------------------------------------- Optimal-parsing deflate

type Op = { lit: number } | { len: number; dist: number };

const clen = (a: Uint8Array, i: number): number => { const v = a[i]; return v === 0 ? 15 : v; };
function matchBitCost(len: number, dist: number, lenLen: Uint8Array, distLen: Uint8Array): number {
  const lc = LEN_CODE_OF[len];
  const dc = DIST_CODE_OF[dist];
  return clen(lenLen, 257 + lc) + LEN_EXTRA[lc] + clen(distLen, dc) + DIST_EXTRA[dc];
}

const FORCE_LEN = 96;

function buildSkeleton(data: Uint8Array, bs: number, be: number, matcher: Matcher): { jump: Int32Array; jumpDist: Int32Array; covered: Uint8Array } {
  const n = be - bs;
  const jump = new Int32Array(n + 1);
  const jumpDist = new Int32Array(n + 1);
  const covered = new Uint8Array(n + 1);
  let j = 0;
  while (j < n) {
    const { len: L, dist: D } = matcher.bestAt(bs + j);
    const take = Math.min(L, n - j);
    if (L >= FORCE_LEN && take >= 16) {
      jump[j] = take;
      jumpDist[j] = D;
      for (let k = 1; k < take; k++) covered[j + k] = 1;
      j += take;
    } else {
      j++;
    }
  }
  return { jump, jumpDist, covered };
}

// One shortest-path run over a block. Costs are bit lengths under the
// current Huffman tables. Returns the chosen ops and their frequencies.
function runDP(
  data: Uint8Array,
  bs: number,
  be: number,
  matcher: Matcher,
  jump: Int32Array,
  jumpDist: Int32Array,
  covered: Uint8Array,
  litLen: Uint8Array,
  distLen: Uint8Array,
): { ops: Op[]; freqLit: Uint32Array; freqDist: Uint32Array } {
  const n = be - bs;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const prev = new Int32Array(n + 1).fill(-1);
  const prevLen = new Int16Array(n + 1);
  const prevDist = new Int32Array(n + 1);
  cost[0] = 0;
  for (let j = 0; j < n; j++) {
    const c = cost[j];
    if (!isFinite(c)) continue;
    if (covered[j]) continue;
    const i = bs + j;
    if (jump[j] > 0) {
      const L = jump[j];
      const D = jumpDist[j];
      const next = j + L;
      const nc = c + matchBitCost(L, D, litLen, distLen);
      if (nc < cost[next]) {
        cost[next] = nc;
        prev[next] = j;
        prevLen[next] = L;
        prevDist[next] = D;
      }
      continue;
    }
    // Literal.
    if (!covered[j + 1]) {
      const nc = c + clen(litLen, data[i]);
      if (nc < cost[j + 1]) {
        cost[j + 1] = nc;
        prev[j + 1] = j;
        prevLen[j + 1] = 1;
        prevDist[j + 1] = 0;
      }
    }
    // Matches: the longest, and the best at a short distance (a slightly
    // shorter match nearby often beats a long match far away).
    const { len: L, dist: D, lenNear: LN, distNear: DN } = matcher.bestAt(i);
    const tryMatch = (LL: number, DD: number) => {
      for (const l of CANDIDATES[LL]) {
        if (j + l > n) break;
        if (covered[j + l]) continue;
        const nc = c + matchBitCost(l, DD, litLen, distLen);
        if (nc < cost[j + l]) {
          cost[j + l] = nc;
          prev[j + l] = j;
          prevLen[j + l] = l;
          prevDist[j + l] = DD;
        }
      }
    };
    if (L >= 3) tryMatch(L, D);
    if (LN >= 3 && DN !== D) tryMatch(LN, DN);
  }
  const ops: Op[] = [];
  let j = n;
  while (j > 0) {
    const p = prev[j];
    const l = prevLen[j];
    const d = prevDist[j];
    if (l === 1 && d === 0) ops.push({ lit: data[bs + p] });
    else ops.push({ len: l, dist: d });
    j = p;
  }
  ops.reverse();
  const freqLit = new Uint32Array(286);
  const freqDist = new Uint32Array(30);
  for (const op of ops) {
    if ('lit' in op) freqLit[op.lit]++;
    else {
      freqLit[257 + LEN_CODE_OF[op.len]]++;
      freqDist[DIST_CODE_OF[op.dist]]++;
    }
  }
  freqLit[256]++;
  return { ops, freqLit, freqDist };
}

// The code-length alphabet order for the dynamic header.
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function emitOps(bw: BitWriter, ops: Op[], litCodes: Uint32Array, litLengths: Uint8Array, distCodes: Uint32Array, distLengths: Uint8Array): void {
  for (const op of ops) {
    if ('lit' in op) {
      bw.writeCode(litCodes[op.lit], litLengths[op.lit]);
    } else {
      const lc = LEN_CODE_OF[op.len];
      bw.writeCode(litCodes[257 + lc], litLengths[257 + lc]);
      if (LEN_EXTRA[lc] > 0) bw.writeBits(op.len - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = DIST_CODE_OF[op.dist];
      bw.writeCode(distCodes[dc], distLengths[dc]);
      if (DIST_EXTRA[dc] > 0) bw.writeBits(op.dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  bw.writeCode(litCodes[256], litLengths[256]);
}

// A block with a dynamic Huffman header.
function emitBlock(bw: BitWriter, ops: Op[], litLengths: Uint8Array, distLengths: Uint8Array, isLast: boolean): void {
  // A block with no matches still needs a usable distance code: one code
  // of one bit (the case inflate accepts for an unused distance alphabet).
  let allZeroDist = true;
  for (let s = 0; s < distLengths.length; s++) if (distLengths[s] > 0) allZeroDist = false;
  if (allZeroDist) distLengths = Uint8Array.of(1);
  let hlit = 286;
  while (hlit > 257 && litLengths[hlit - 1] === 0) hlit--;
  let hdist = distLengths.length;
  while (hdist > 1 && distLengths[hdist - 1] === 0) hdist--;
  const litCodes = canonicalCodes(litLengths);
  const distCodes = canonicalCodes(distLengths);
  // Run-length encode the code lengths.
  const lens: number[] = [];
  for (let s = 0; s < hlit; s++) lens.push(litLengths[s]);
  for (let s = 0; s < hdist; s++) lens.push(distLengths[s]);
  type Seq = { sym: number; extra: number; extraBits: number };
  const seq: Seq[] = [];
  const clFreq = new Uint32Array(19);
  let i = 0;
  while (i < lens.length) {
    const len = lens[i];
    let run = 1;
    while (i + run < lens.length && lens[i + run] === len) run++;
    if (len === 0) {
      let r = run;
      while (r >= 11) {
        const take = Math.min(r, 138);
        seq.push({ sym: 18, extra: take - 11, extraBits: 7 });
        clFreq[18]++;
        r -= take;
      }
      if (r >= 3) {
        seq.push({ sym: 17, extra: r - 3, extraBits: 3 });
        clFreq[17]++;
        r = 0;
      }
      while (r-- > 0) {
        seq.push({ sym: 0, extra: 0, extraBits: 0 });
        clFreq[0]++;
      }
    } else {
      seq.push({ sym: len, extra: 0, extraBits: 0 });
      clFreq[len]++;
      let r = run - 1;
      while (r >= 3) {
        const take = Math.min(r, 6);
        seq.push({ sym: 16, extra: take - 3, extraBits: 2 });
        clFreq[16]++;
        r -= take;
      }
      while (r-- > 0) {
        seq.push({ sym: len, extra: 0, extraBits: 0 });
        clFreq[len]++;
      }
    }
    i += run;
  }
  const clLengths = huffmanLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLengths[CL_ORDER[hclen - 1]] === 0) hclen--;
  const clCodes = canonicalCodes(clLengths);
  bw.writeBits(isLast ? 1 : 0, 1);
  bw.writeBits(2, 2);
  bw.writeBits(hlit - 257, 5);
  bw.writeBits(hdist - 1, 5);
  bw.writeBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.writeBits(clLengths[CL_ORDER[k]], 3);
  for (const s of seq) {
    bw.writeCode(clCodes[s.sym], clLengths[s.sym]);
    if (s.extraBits > 0) bw.writeBits(s.extra, s.extraBits);
  }
  emitOps(bw, ops, litCodes, litLengths, distCodes, distLengths);
}

// A block with the fixed Huffman tables (BTYPE 01): the only correct way to
// use the fixed tables, since a dynamic header cannot carry all 288
// literal/length and 32 distance codes.
function emitFixedBlock(bw: BitWriter, ops: Op[], isLast: boolean): void {
  const litCodes = canonicalCodes(FIXED_LIT_LEN);
  const distCodes = canonicalCodes(FIXED_DIST_LEN);
  bw.writeBits(isLast ? 1 : 0, 1);
  bw.writeBits(1, 2);
  emitOps(bw, ops, litCodes, FIXED_LIT_LEN, distCodes, FIXED_DIST_LEN);
}

// The optimal-parsing deflate of `data` as one zlib stream. Blocks are split
// at row boundaries near 128 KiB; each block gets two shortest-path passes
// (fixed Huffman costs, then the costs of the first pass's own Huffman code).
function deflateOptimal(data: Uint8Array, rowLen: number): Uint8Array {
  const blocks: [number, number][] = [];
  let bs = 0;
  while (bs < data.length) {
    let be = Math.min(data.length, bs + 524288);
    if (be < data.length) {
      be = bs + Math.floor((be - bs) / rowLen) * rowLen;
      if (be <= bs) be = Math.min(data.length, bs + rowLen);
    }
    blocks.push([bs, be]);
    bs = be;
  }
  const matcher = new Matcher(data);
  const bw = new BitWriter();
  let fixedBlocks = 0;
  for (let bi = 0; bi < blocks.length; bi++) {
    const [b0, b1] = blocks[bi];
    const { jump, jumpDist, covered } = buildSkeleton(data, b0, b1, matcher);
    const fixedDist = new Uint8Array(30).fill(5);
    let litLengths: Uint8Array = FIXED_LIT_LEN;
    let distLengths: Uint8Array = fixedDist;
    let r2: { ops: Op[]; freqLit: Uint32Array; freqDist: Uint32Array } | null = null;
    const ITERS = 3;
    for (let it = 0; it < ITERS; it++) {
      r2 = runDP(data, b0, b1, matcher, jump, jumpDist, covered, litLengths, distLengths);
      litLengths = huffmanLengths(r2.freqLit, 15);
      distLengths = huffmanLengths(r2.freqDist, 15);
    }
    if (r2 === null) throw new Error("no dp");
    const last = bi === blocks.length - 1;
    if (lengthsValid(litLengths, r2.freqLit, 15) && lengthsValid(distLengths, r2.freqDist, 15)) {
      emitBlock(bw, r2.ops, litLengths, distLengths, last);
    } else {
      fixedBlocks++;
      emitFixedBlock(bw, r2.ops, last);
    }
  }
  bw.alignByte();
  const raw = bw.toBytes();
  const out = new Uint8Array(2 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(raw, 2);
  const ad = adler32(data);
  out[2 + raw.length] = (ad >>> 24) & 0xff;
  out[2 + raw.length + 1] = (ad >>> 16) & 0xff;
  out[2 + raw.length + 2] = (ad >>> 8) & 0xff;
  out[2 + raw.length + 3] = ad & 0xff;
  if (process.env.PQ_DEBUG) console.error(`deflateOptimal: ${blocks.length} blocks, ${fixedBlocks} fixed, ${raw.length} bytes`);
  return out;
}

// ---------------------------------------------------------------- Entry

function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const chunks: [string, Uint8Array][] = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// Screen every form and filter strategy by zlib level 6 (the kit's screen
// level), keep the smallest.
function screenImage(rgba: Uint8Array, width: number, height: number): { form: Form; choice: number | string; data: Uint8Array } {
  let best: { form: Form; choice: number | string; data: Uint8Array; bytes: number } | null = null;
  for (const form of formsOf(rgba)) {
    const extra = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filteredData(form.samples, width, height, form.bpp, choice);
      const bytes = deflateSync(data, { level: 6, memLevel: 8 }).length + extra;
      if (best === null || bytes < best.bytes) best = { form, choice, data, bytes };
    }
  }
  if (best === null) throw new Error('no form');
  return { form: best.form, choice: best.choice, data: best.data };
}

function squeezeOne(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const { form, choice, data } = screenImage(rgba, width, height);
  const rowLen = width * form.bpp + 1;
  const mine = deflateOptimal(data, rowLen);
  const z9 = deflateSync(data, { level: 9, memLevel: 9 });
  const stream = mine.length <= z9.length ? mine : new Uint8Array(z9.buffer, z9.byteOffset, z9.length);
  if (process.env.PQ_DEBUG) {
    console.error(`squeeze: ct${form.colourType} filter=${choice} raw=${data.length} mine=${mine.length} zl9=${z9.length} chose=${mine.length <= z9.length ? 'mine' : 'zl9'}`);
  }
  return pngOfForm(width, height, form, stream);
}


const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const inPath = join(I, id, 'image.png');
  const outDir = join(O, id);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'image.png');
  try {
    const file = new Uint8Array(readFileSync(inPath));
    const image = decodePng(file);
    if (!image.ok) throw new Error(id + ': ' + image.why);
    writeFileSync(outPath, squeezeOne(image.rgba, image.width, image.height));
  } catch {
    // Never leave an instance unanswered: the stored input is a valid,
    // exact PNG (0 points, but valid and in format).
    copyFileSync(inPath, outPath);
  }
}
