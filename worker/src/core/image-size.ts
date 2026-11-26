// Pure header parsing for PNG / JPEG / GIF / WebP. Anything unreadable (or any other type) yields null.

export interface ImageSize { width: number; height: number }

const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  if (at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};
const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const le16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const le24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

const size = (width: number, height: number): ImageSize | null =>
  width > 0 && height > 0 ? { width, height } : null;

function png(b: Uint8Array): ImageSize | null {
  // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4).
  if (b.length < 24 || b[0] !== 0x89 || !ascii(b, 1, "PNG") || !ascii(b, 12, "IHDR")) return null;
  return size(be32(b, 16), be32(b, 20));
}

function gif(b: Uint8Array): ImageSize | null {
  if (b.length < 10 || !(ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) return null;
  return size(le16(b, 6), le16(b, 8));
}

function webp(b: Uint8Array): ImageSize | null {
  if (b.length < 20 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8X")) {
    if (b.length < 30) return null;
    return size(le24(b, 24) + 1, le24(b, 27) + 1);
  }
  if (ascii(b, 12, "VP8L")) {
    // 0x2f signature, then 14 bits width-1 and 14 bits height-1.
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (ascii(b, 12, "VP8 ")) {
    // Frame tag(3) start code 9d 01 2a, then 14-bit width and height (top 2 bits are scaling).
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return size(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  }
  return null;
}

function jpeg(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS: no frame header before the data
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) { i += 2; continue; } // standalone markers
    const len = be16(b, i + 2);
    if (len < 2) return null;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null;
      return size(be16(b, i + 7), be16(b, i + 5));
    }
    i += 2 + len;
  }
  return null;
}

export function imageSize(bytes: Uint8Array, mimeType: string): ImageSize | null {
  switch (mimeType.toLowerCase()) {
    case "image/png": return png(bytes);
    case "image/jpeg":
    case "image/jpg": return jpeg(bytes);
    case "image/gif": return gif(bytes);
    case "image/webp": return webp(bytes);
    default: return null;
  }
}
