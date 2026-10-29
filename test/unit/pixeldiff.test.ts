import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { diffPngs } from "../../src/evaluate/pixeldiff.js";

function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = paint(x, y);
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  return PNG.sync.write(img);
}

describe("pixel diff (base vs HEAD)", () => {
  const white = () => [255, 255, 255] as [number, number, number];
  it("identical screenshots differ in no pixel", () => {
    const d = diffPngs(png(20, 10, white), png(20, 10, white));
    expect(d).toMatchObject({ pixels: 0, ratio: 0, width: 20, height: 10 });
    expect(PNG.sync.read(d.png).width).toBe(20);
  });
  it("counts changed pixels and writes a diff image", () => {
    const d = diffPngs(png(10, 10, white), png(10, 10, (x, y) => (x < 5 && y < 2 ? [0, 0, 0] : [255, 255, 255])));
    expect(d.pixels).toBe(10);
    expect(d.ratio).toBeCloseTo(0.1);
  });
  it("a size change pads the smaller image and counts the new area", () => {
    const d = diffPngs(png(10, 10, white), png(10, 12, white));
    expect(d).toMatchObject({ width: 10, height: 12, pixels: 20 });
  });
});
