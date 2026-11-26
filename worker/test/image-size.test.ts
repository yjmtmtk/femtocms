import { expect, it } from "vitest";
import { imageSize } from "../src/core/image-size";
import { fixtures } from "./fixtures/images";

const u8 = (...parts: (number | number[] | string)[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const le32 = (n: number) => [...le16(n & 0xffff), ...le16(n >>> 16)];

it.each(["png", "jpeg", "gif", "webp"] as const)("%s のサイズを読める", (k) => {
  expect(imageSize(fixtures[k], `image/${k}`)).toEqual({ width: 1, height: 1 });
});

it("壊れたバイト列は null", () => expect(imageSize(new Uint8Array([1, 2, 3]), "image/png")).toBeNull());
it("空のバイト列は null", () => expect(imageSize(new Uint8Array(), "image/gif")).toBeNull());
it("対応しない mime type は null", () => {
  expect(imageSize(fixtures.png, "image/svg+xml")).toBeNull();
  expect(imageSize(fixtures.png, "application/pdf")).toBeNull();
});
it("mime type とバイト列が食い違うと null", () => expect(imageSize(fixtures.png, "image/jpeg")).toBeNull());
it("image/jpg でも JPEG として読める", () => expect(imageSize(fixtures.jpeg, "image/jpg")).toEqual({ width: 1, height: 1 }));

it("PNG は IHDR の幅と高さを読む", () => {
  const png = u8([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(640), be32(480), [8, 2, 0, 0, 0]);
  expect(imageSize(png, "image/png")).toEqual({ width: 640, height: 480 });
});
it("PNG の IHDR が途中で切れていたら null", () => {
  expect(imageSize(fixtures.png.slice(0, 20), "image/png")).toBeNull();
});

it("GIF は論理画面の幅と高さを読む", () => {
  expect(imageSize(u8("GIF89a", le16(320), le16(240), [0, 0, 0]), "image/gif")).toEqual({ width: 320, height: 240 });
});

it("WebP VP8L", () => {
  // 14 bits width-1, 14 bits height-1, little endian after the 0x2f signature.
  const bits = 299 | (199 << 14);
  const chunk = u8("VP8L", le32(5), [0x2f], le32(bits));
  const webp = u8("RIFF", le32(4 + chunk.length), "WEBP", [...chunk]);
  expect(imageSize(webp, "image/webp")).toEqual({ width: 300, height: 200 });
});
it("WebP VP8X", () => {
  const chunk = u8("VP8X", le32(10), [0, 0, 0, 0], le24(799), le24(599));
  const webp = u8("RIFF", le32(4 + chunk.length), "WEBP", [...chunk]);
  expect(imageSize(webp, "image/webp")).toEqual({ width: 800, height: 600 });
});
it("WebP VP8 (lossy)", () => {
  const chunk = u8("VP8 ", le32(10), [0, 0, 0], [0x9d, 0x01, 0x2a], le16(123), le16(45));
  const webp = u8("RIFF", le32(4 + chunk.length), "WEBP", [...chunk]);
  expect(imageSize(webp, "image/webp")).toEqual({ width: 123, height: 45 });
});

it("JPEG は APP セグメントを飛ばして SOF を読む（プログレッシブ SOF2 も）", () => {
  const app0 = u8([0xff, 0xe0], be16(16), "JFIF", [0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof2 = u8([0xff, 0xc2], be16(11), [8], be16(200), be16(300), [1, 1, 0x11, 0]);
  const jpeg = u8([0xff, 0xd8], [...app0], [...sof2], [0xff, 0xd9]);
  expect(imageSize(jpeg, "image/jpeg")).toEqual({ width: 300, height: 200 });
});
it("JPEG: DHT(0xC4) や DAC(0xCC) は SOF として扱わない", () => {
  const dht = u8([0xff, 0xc4], be16(4), [0, 0]);
  const sof0 = u8([0xff, 0xc0], be16(11), [8], be16(7), be16(9), [1, 1, 0x11, 0]);
  expect(imageSize(u8([0xff, 0xd8], [...dht], [...sof0]), "image/jpeg")).toEqual({ width: 9, height: 7 });
});
it("JPEG に SOF が無ければ null", () => {
  expect(imageSize(u8([0xff, 0xd8], [0xff, 0xd9]), "image/jpeg")).toBeNull();
});
it("JPEG のセグメント長が壊れていても止まって null", () => {
  expect(imageSize(u8([0xff, 0xd8], [0xff, 0xe0], be16(0)), "image/jpeg")).toBeNull();
});
