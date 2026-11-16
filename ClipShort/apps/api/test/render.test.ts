import { describe, expect, it } from "vitest";
import { buildVideoFilter } from "../src/render.js";

describe("buildVideoFilter", () => {
  it("scales and center-crops portrait output", () => {
    const filter = buildVideoFilter("center");
    expect(filter).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
    expect(filter).toContain("crop=1080:1920");
    expect(filter).toContain("format=yuv420p");
  });
  it("uses a clamped horizontal crop position", () => {
    expect(buildVideoFilter("custom", 0.25)).toContain("x=(iw-1080)*0.2500");
    expect(buildVideoFilter("custom", 4)).toContain("x=(iw-1080)*1.0000");
  });
  it("builds a blurred background and centered foreground", () => {
    const filter = buildVideoFilter("blur");
    expect(filter).toContain("split=2");
    expect(filter).toContain("boxblur=30:10");
    expect(filter).toContain("overlay=(W-w)/2:(H-h)/2");
  });
});
