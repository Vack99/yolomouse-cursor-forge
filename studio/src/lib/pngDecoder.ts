// Minimal PNG decoder — enough to load our test-fixture and reference images
// (8-bit/RGBA, non-interlaced). Avoids adding an image-codec dependency.
//
// Supports:
//   - bit depth 8
//   - colour type 6 (RGBA)
//   - filter method 0 (the only one defined by the spec)
//   - interlace method 0 (Adam7 is rejected loudly)
//
// Anything outside that envelope throws, because silently producing wrong
// pixels would be worse than failing the import.

import * as zlib from 'node:zlib';

export interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! * 0x1000000) +
    ((buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!)
  );
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  if (bytes.length < 8) throw new Error('pngDecoder: file too short');
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('pngDecoder: not a PNG file');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idatChunks: Uint8Array[] = [];

  while (offset < bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (type === 'IHDR') {
      width = readUint32BE(bytes, dataStart);
      height = readUint32BE(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colourType = bytes[dataStart + 9]!;
      // compression method (10) and filter method (11) are always 0 in spec.
      interlace = bytes[dataStart + 12]!;
    } else if (type === 'IDAT') {
      idatChunks.push(bytes.slice(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    // chunk = length (4) + type (4) + data (length) + crc (4)
    offset = dataEnd + 4;
  }

  if (bitDepth !== 8) throw new Error(`pngDecoder: bit depth ${bitDepth} not supported (need 8)`);
  if (colourType !== 6) throw new Error(`pngDecoder: colour type ${colourType} not supported (need 6 = RGBA)`);
  if (interlace !== 0) throw new Error('pngDecoder: interlaced PNGs are not supported');

  // Concatenate IDAT and inflate.
  const totalIdat = idatChunks.reduce((s, c) => s + c.length, 0);
  const idat = new Uint8Array(totalIdat);
  let pos = 0;
  for (const c of idatChunks) { idat.set(c, pos); pos += c.length; }
  const inflated = zlib.inflateSync(idat);

  const bytesPerPixel = 4; // RGBA at 8 bits
  const stride = width * bytesPerPixel;
  const out = new Uint8Array(width * height * bytesPerPixel);

  // Each row in inflated data is prefixed by a filter byte.
  // Apply the four reconstructive filters per the PNG spec (§9.2).
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)]!;
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const raw = inflated[rowStart + x]!;
      const left = x >= bytesPerPixel ? out[y * stride + x - bytesPerPixel]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const upLeft = (y > 0 && x >= bytesPerPixel) ? out[(y - 1) * stride + x - bytesPerPixel]! : 0;
      let recon: number;
      switch (filter) {
        case 0: recon = raw; break;
        case 1: recon = raw + left; break;
        case 2: recon = raw + up; break;
        case 3: recon = raw + ((left + up) >> 1); break;
        case 4: recon = raw + paeth(left, up, upLeft); break;
        default: throw new Error(`pngDecoder: unknown filter ${filter} on row ${y}`);
      }
      out[y * stride + x] = recon & 0xff;
    }
  }

  return { width, height, pixels: out };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
