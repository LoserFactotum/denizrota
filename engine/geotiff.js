// Port of ios/DenizRota/Core/MarineGrid.c — dm_read_geotiff and dm_min_depth.
//
// Numeric, north-up EPSG:4326 single-band GeoTIFF only. Unsupported encodings
// are REJECTED, never rendered into RGB and reinterpreted as depths. Every
// rejection returns a nonzero code with the same meaning as the C original,
// so a source change surfaces as an error instead of a silent wrong depth.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 9: 4, 11: 4, 12: 8 };

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.n = bytes.length;
    this.little = bytes[0] === 0x49; // 'I'
  }
  // Mirrors word(): out-of-range reads yield 0 rather than throwing.
  fits(p, size) { return p >= 0 && p <= this.n && size <= this.n - p; }
  u8(p) { return this.fits(p, 1) ? this.view.getUint8(p) : 0; }
  u16(p) { return this.fits(p, 2) ? this.view.getUint16(p, this.little) : 0; }
  u32(p) { return this.fits(p, 4) ? this.view.getUint32(p, this.little) : 0; }
}

function tagEntry(rd, id) {
  const p = rd.u32(4);
  if (p > rd.n || rd.n - p < 2) return null;
  const n = rd.u16(p);
  if (n > 4096 || rd.n - p - 2 < n * 12 + 4) return null;
  for (let i = 0; i < n; i++) {
    const q = p + 2 + 12 * i;
    if (rd.u16(q) !== id) continue;
    const type = rd.u16(q + 2), count = rd.u32(q + 4);
    const s = TYPE_SIZE[type] || 0;
    if (!s || count > rd.n / s) return null;
    const bytes = count * s;
    const pos = bytes <= 4 ? q + 8 : rd.u32(q + 8);
    if (!(pos <= rd.n && bytes <= rd.n - pos)) return null;
    return { type, count, pos };
  }
  return null;
}

function tagValue(rd, t, i) {
  if (i >= t.count) return NaN;
  const s = TYPE_SIZE[t.type] || 0;
  const p = t.pos + i * s;
  if (!rd.fits(p, s)) return 0;
  switch (t.type) {
    case 12: return rd.view.getFloat64(p, rd.little);
    case 11: return rd.view.getFloat32(p, rd.little);
    case 9: return rd.view.getInt32(p, rd.little);
    case 1: case 2: return rd.view.getUint8(p);
    case 3: return rd.view.getUint16(p, rd.little);
    case 4: return rd.view.getUint32(p, rd.little);
    default: return 0;
  }
}

function scalar(rd, id, fallback) {
  const t = tagEntry(rd, id);
  return t && t.count === 1 && (t.type === 3 || t.type === 4) ? tagValue(rd, t, 0) : fallback;
}

// C strtod semantics: leading space, optional sign, decimal/exponent, inf, nan.
// Returns null when no conversion is possible (the C `end == text` case).
function strtod(text) {
  const m = /^\s*([+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?|[nN][aA][nN]))/.exec(text);
  if (!m) return null;
  const s = m[1];
  if (/inf/i.test(s)) return s[0] === '-' ? -Infinity : Infinity;
  if (/nan/i.test(s)) return NaN;
  return Number(s);
}

/** Adler-32 of the uncompressed data, as stored at the end of a zlib stream. */
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const stop = Math.min(bytes.length, i + 5552); // NMAX: no overflow before reducing
    for (; i < stop; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function join(chunks, length) {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/**
 * One decompression attempt. Returns {output, produced}: output is non-null only
 * when the stream ended cleanly with exactly expectedLength bytes.
 *
 * The stream is drained with an explicit reader rather than `for await`, because
 * ReadableStream async iteration is missing on older iOS Safari and this app is
 * meant to run on whatever phone is on the boat.
 */
async function inflateOnce(bytes, expectedLength) {
  let reader;
  try {
    reader = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('deflate')).getReader();
  } catch { return { output: null, produced: null }; }
  const chunks = [];
  let total = 0;
  let clean = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { clean = true; break; }
      chunks.push(value);
      total += value.length;
      // uncompress() into a rawN buffer fails with Z_BUF_ERROR when the output is
      // longer; stopping here also bounds memory for a hostile response.
      if (total > expectedLength) {
        try { await reader.cancel(); } catch { /* yoksay */ }
        return { output: null, produced: null };
      }
    }
  } catch { /* asagida ele aliniyor */ }
  if (total !== expectedLength) return { output: null, produced: null };
  const produced = join(chunks, total);
  return { output: clean ? produced : null, produced };
}

/**
 * Inflate one Deflate block the way the C's zlib uncompress() does.
 *
 * uncompress() stops at the end of the zlib stream and ignores any bytes that
 * follow inside the declared StripByteCounts/TileByteCounts. DecompressionStream
 * instead rejects them as trailing junk. A file the C decodes must not fail here.
 *
 * But a corrupt block ALSO fails late, after emitting output, and accepting that
 * would mean routing on wrong depths. The two are told apart by the checksum:
 * a zlib stream ends with the Adler-32 of its own output, so if the output we
 * produced is genuine, that checksum must appear in the input at the stream end.
 * We look for it and re-run on the exact stream; corrupt data never matches.
 *
 * Returns null on any failure, so the caller reports GeoTIFFError(12) — the same
 * status the C returns for every non-Z_OK result.
 */
async function inflate(bytes, expectedLength) {
  const first = await inflateOnce(bytes, expectedLength);
  if (first.output) return first.output;
  if (!first.produced) return null;

  const want = adler32(first.produced);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let p = 2; p + 4 <= bytes.length; p++) {
    if (view.getUint32(p, false) !== want) continue;
    const retry = await inflateOnce(bytes.subarray(0, p + 4), expectedLength);
    if (retry.output) return retry.output;
  }
  return null;
}

export class GeoTIFFError extends Error {
  constructor(code) {
    super(`Sayisal derinlik dosyasi okunamadi (GeoTIFF ${code}).`);
    this.code = code;
  }
}

/**
 * Decode a numeric bathymetry GeoTIFF.
 * Resolves to {rows, columns, west, north, dx, dy, values:Float64Array}.
 * Values keep the source sign (EMODnet WCS returns elevations).
 * Rejects with GeoTIFFError carrying the C status code on any unsupported form.
 */
export async function readGeoTIFF(bytes) {
  if (!bytes || bytes.length < 8 || bytes.length > 100000000) throw new GeoTIFFError(1);
  const rd = new Reader(bytes);
  const bigEndian = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!((bytes[0] === 0x49 && bytes[1] === 0x49) || bigEndian) || rd.u16(2) !== 42) throw new GeoTIFFError(2);

  const columns = Math.trunc(scalar(rd, 256, 0)), rows = Math.trunc(scalar(rd, 257, 0));
  if (!columns || !rows || columns > 8192 || rows > 8192 || rows * columns > 5000000) throw new GeoTIFFError(3);

  const bits = Math.trunc(scalar(rd, 258, 0)), format = Math.trunc(scalar(rd, 339, 1));
  const compression = Math.trunc(scalar(rd, 259, 1)), predictor = Math.trunc(scalar(rd, 317, 1));
  if (scalar(rd, 277, 1) !== 1 || scalar(rd, 274, 1) !== 1 || scalar(rd, 284, 1) !== 1
    || scalar(rd, 262, 1) !== 1 || (bits !== 16 && bits !== 32 && bits !== 64)
    || !((format === 2 && (bits === 16 || bits === 32)) || (format === 3 && (bits === 32 || bits === 64)))) {
    throw new GeoTIFFError(4);
  }
  if ((compression !== 1 && compression !== 8 && compression !== 32946) || predictor !== 1) throw new GeoTIFFError(5);

  const keys = tagEntry(rd, 34735);
  if (!keys || keys.type !== 3 || keys.count < 4) throw new GeoTIFFError(6);
  let geographic = false, area = 1, model = 0;
  const keyCount = Math.trunc(tagValue(rd, keys, 3));
  if (keyCount > (keys.count - 4) / 4) throw new GeoTIFFError(6);
  for (let i = 0; i < keyCount; i++) {
    const id = Math.trunc(tagValue(rd, keys, 4 + i * 4));
    const location = tagValue(rd, keys, 5 + i * 4);
    const count = tagValue(rd, keys, 6 + i * 4);
    const v = tagValue(rd, keys, 7 + i * 4);
    if (location === 0 && count === 1) {
      if (id === 2048) geographic = v === 4326;
      if (id === 1024) model = Math.trunc(v);
      if (id === 1025) area = Math.trunc(v);
    }
  }
  if (!geographic || model !== 2 || (area !== 1 && area !== 2)) throw new GeoTIFFError(7);

  let dx, dy, west, north;
  const matrix = tagEntry(rd, 34264);
  if (matrix) {
    if (matrix.type !== 12 || matrix.count !== 16 || tagValue(rd, matrix, 1) !== 0
      || tagValue(rd, matrix, 2) !== 0 || tagValue(rd, matrix, 4) !== 0 || tagValue(rd, matrix, 6) !== 0
      || tagValue(rd, matrix, 12) !== 0 || tagValue(rd, matrix, 13) !== 0 || tagValue(rd, matrix, 14) !== 0
      || tagValue(rd, matrix, 15) !== 1) throw new GeoTIFFError(6);
    dx = tagValue(rd, matrix, 0); dy = -tagValue(rd, matrix, 5);
    west = tagValue(rd, matrix, 3); north = tagValue(rd, matrix, 7);
  } else {
    const scale = tagEntry(rd, 33550), tie = tagEntry(rd, 33922);
    if (!scale || scale.type !== 12 || scale.count < 2 || !tie || tie.type !== 12 || tie.count !== 6) {
      throw new GeoTIFFError(6);
    }
    dx = tagValue(rd, scale, 0); dy = tagValue(rd, scale, 1);
    west = tagValue(rd, tie, 3) - tagValue(rd, tie, 0) * dx;
    north = tagValue(rd, tie, 4) + tagValue(rd, tie, 1) * dy;
  }
  if (area === 2) { west -= dx / 2; north += dy / 2; }
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || dx <= 0 || dy <= 0 || dx > 1 || dy > 1
    || !Number.isFinite(west) || !Number.isFinite(north) || west < -180 || west + columns * dx > 180.0001
    || north > 90.0001 || north - rows * dy < -90.0001) throw new GeoTIFFError(8);

  let noData = NaN;
  const nd = tagEntry(rd, 42113);
  if (nd) {
    if (nd.type !== 2 || nd.count === 0 || nd.count > 128) throw new GeoTIFFError(8);
    let text = '';
    for (let i = 0; i < nd.count; i++) text += String.fromCharCode(rd.u8(nd.pos + i));
    const parsed = strtod(text);
    if (parsed === null) throw new GeoTIFFError(8);
    noData = parsed;
  }

  let offsets = tagEntry(rd, 324);
  const tiled = !!offsets;
  if (!tiled) offsets = tagEntry(rd, 273);
  if (!offsets) throw new GeoTIFFError(9);
  const counts = tagEntry(rd, tiled ? 325 : 279);
  if (!counts || offsets.count !== counts.count
    || (offsets.type !== 3 && offsets.type !== 4) || (counts.type !== 3 && counts.type !== 4)) {
    throw new GeoTIFFError(9);
  }
  const bw = tiled ? Math.trunc(scalar(rd, 322, 0)) : columns;
  const bh = Math.trunc(scalar(rd, tiled ? 323 : 278, rows));
  if (!bw || !bh || bw > 8192 || bh > 8192) throw new GeoTIFFError(9);
  const nx = Math.ceil(columns / bw), ny = Math.ceil(rows / bh);
  if (offsets.count !== nx * ny) throw new GeoTIFFError(9);

  const values = new Float64Array(rows * columns);
  const sample = bits / 8;
  const little = rd.little;
  for (let b = 0; b < nx * ny; b++) {
    const off = Math.trunc(tagValue(rd, offsets, b)), n = Math.trunc(tagValue(rd, counts, b));
    const h = tiled ? bh : (b * bh + bh > rows ? rows - b * bh : bh);
    const rawN = bw * h * sample;
    if (off > bytes.length || n > bytes.length - off || !n || rawN > 100000000) throw new GeoTIFFError(11);
    let raw;
    if (compression === 1) {
      if (n !== rawN) throw new GeoTIFFError(11);
      raw = bytes.subarray(off, off + n);
    } else {
      raw = await inflate(bytes.subarray(off, off + n), rawN);
      if (!raw) throw new GeoTIFFError(12);
    }
    const chunk = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const rowBase = Math.trunc(b / nx) * bh, colBase = (b % nx) * bw;
    for (let y = 0; y < h; y++) {
      const row = rowBase + y;
      if (row >= rows) continue;
      for (let x = 0; x < bw; x++) {
        const col = colBase + x;
        if (col >= columns) continue;
        const p = (y * bw + x) * sample;
        let d;
        if (p + sample > raw.length) d = 0; // matches word()'s out-of-range zero
        else if (format === 2) d = bits === 16 ? chunk.getInt16(p, little) : chunk.getInt32(p, little);
        else if (bits === 32) d = chunk.getFloat32(p, little);
        else d = chunk.getFloat64(p, little);
        values[row * columns + col] = !Number.isFinite(d) || d === noData || Math.abs(d) > 15000 ? NaN : d;
      }
    }
  }
  return { rows, columns, west, north, dx, dy, values };
}

/**
 * Shallowest depth of ALL source pixels intersecting the rectangle, in metres
 * below the source datum (depth = -elevation). NaN if ANY intersecting pixel is
 * missing — an unknown cell must never be interpolated into supposedly safe water.
 *
 * padX/padY widen the sampled rectangle without widening the accepted request.
 * This keeps a planning cell smaller than a source pixel from seeing FEWER
 * pixels than a coarse cell would: the shoal in the adjacent pixel still counts.
 * At padX = padY = 0 this is byte-identical to the C dm_min_depth.
 */
export function minDepth(raster, w, s, e, n, padX = 0, padY = 0) {
  if (!raster || !raster.values) return NaN;
  if (!Number.isFinite(w) || !Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(n)) return NaN;
  const east = raster.west + raster.columns * raster.dx;
  const south = raster.north - raster.rows * raster.dy;
  if (w >= e || s >= n || w < raster.west || e > east || n > raster.north || s < south) return NaN;
  const pw = Math.max(raster.west, w - padX), pe = Math.min(east, e + padX);
  const ps = Math.max(south, s - padY), pn = Math.min(raster.north, n + padY);
  let c0 = Math.floor((pw - raster.west) / raster.dx);
  let c1 = Math.ceil((pe - raster.west) / raster.dx);
  let r0 = Math.floor((raster.north - pn) / raster.dy);
  let r1 = Math.ceil((raster.north - ps) / raster.dy);
  if (c0 < 0) c0 = 0;
  if (r0 < 0) r0 = 0;
  if (c1 > raster.columns) c1 = raster.columns;
  if (r1 > raster.rows) r1 = raster.rows;
  let depth = Infinity;
  const values = raster.values, columns = raster.columns;
  for (let y = r0; y < r1; y++) {
    const base = y * columns;
    for (let x = c0; x < c1; x++) {
      const d = values[base + x];
      if (!Number.isFinite(d)) return NaN;
      if (-d < depth) depth = -d;
    }
  }
  return Number.isFinite(depth) ? depth : NaN;
}
