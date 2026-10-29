import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface PixelDiff {
  /** Differing pixels (size changes count every pixel outside the common area). */
  pixels: number;
  /** pixels / (width · height) of the larger image, 0..1. */
  ratio: number;
  width: number;
  height: number;
  /** Diff image: changed pixels red over a faded copy of HEAD. */
  png: Buffer;
}

function padded(img: PNG, width: number, height: number): Buffer {
  if (img.width === width && img.height === height) return img.data;
  const out = new PNG({ width, height, fill: true });
  out.data.fill(0);
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out.data;
}

/** Pixel diff of two PNG screenshots (base vs HEAD); different sizes are padded. */
export function diffPngs(base: Buffer, head: Buffer, threshold = 0.1): PixelDiff {
  const a = PNG.sync.read(base);
  const b = PNG.sync.read(head);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const out = new PNG({ width, height });
  const pixels = pixelmatch(padded(a, width, height), padded(b, width, height), out.data, width, height, { threshold });
  return { pixels, ratio: pixels / (width * height), width, height, png: PNG.sync.write(out) };
}
