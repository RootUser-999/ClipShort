import { describe, expect, it } from "vitest";
import { clampSelection, clipRequestSchema, InputError, parseYouTubeUrl, sanitizeFilename, videoInfoRequestSchema } from "../src/index.js";

describe("parseYouTubeUrl", () => {
  const id = "dQw4w9WgXcQ";
  it.each([
    `https://youtube.com/watch?v=${id}`,
    `http://www.youtube.com/watch?list=PLx&v=${id}&t=90s`,
    `youtube.com/watch?v=${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abc&t=1m30s`,
    `www.youtu.be/${id}`,
    `https://youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}?start=12`,
    `https://youtube.com/live/${id}`,
    `https://youtube.com/watch?feature=share&v=${id}`,
    `  https://youtu.be/${id}  `,
    `youtube.com/shorts/${id}?feature=share`,
    `m.youtube.com/live/${id}?t=2m`,
    `music.youtube.com/watch?v=${id}&si=xyz`,
    `https://www.youtube.com/embed/${id}?start=15&end=50`,
    `http://youtube.com/live/${id}?feature=shared`,
    `https://youtu.be/${id}?t=01:02`,
    `https://youtube.com/watch?v=${id}&t=1h2m3s`,
    `youtube.com/watch?v=${id}&start=22`,
    `https://m.youtube.com/shorts/${id}/`,
    `https://youtube.com/embed/${id}/`,
    `https://www.youtube.com/watch?app=desktop&v=${id}`,
    `https://music.youtube.com/watch?si=abc&v=${id}&t=42`,
    `https://youtube.com/live/${id}?si=xyz&t=90`,
    `https://youtu.be/${id}?list=PLx&index=2`,
    `www.youtube.com/watch?v=${id}&t=0`,
    `http://m.youtube.com/watch?v=${id}&t=2:30`,
    `https://youtube.com/shorts/${id}?si=share&t=4s`,
  ])("accepts %s", (url) => {
    expect(parseYouTubeUrl(url).videoId).toBe(id);
  });
  it.each([
    "", "example.com/watch?v=dQw4w9WgXcQ", "javascript:alert(1)", "file:///etc/passwd",
    "https://youtube.com/playlist?list=abc", "https://youtube.com/channel/abc",
    "https://youtu.be/not-an-id", "https://youtube.com/watch?v=short",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "https://youtube.com/watch",
  ])("rejects %s", (url) => {
    expect(() => parseYouTubeUrl(url)).toThrow(InputError);
  });
  it("extracts numeric and clock-form timestamps", () => {
    expect(parseYouTubeUrl(`https://youtube.com/watch?v=${id}&t=90s`).startSeconds).toBe(90);
    expect(parseYouTubeUrl(`https://youtube.com/watch?v=${id}&t=1h2m`).startSeconds).toBe(3720);
    expect(parseYouTubeUrl(`https://youtube.com/watch?v=${id}&t=1m30s`).startSeconds).toBe(90);
    expect(parseYouTubeUrl(`https://youtube.com/watch?v=${id}&t=1:02:03`).startSeconds).toBe(3723);
  });
});

describe("selection and filename helpers", () => {
  it("clamps to both video bounds and the 60 second limit in milliseconds", () => {
    expect(clampSelection(5_000, 90_000, 120_000)).toEqual({ startMs: 5_000, endMs: 65_000 });
    expect(clampSelection(-1_000, 80_000, 30_000)).toEqual({ startMs: 0, endMs: 30_000 });
    expect(clampSelection(10_000, 10_000, 60_000)).toEqual({ startMs: 10_000, endMs: 11_000 });
    expect(clampSelection(59_900, 60_500, 60_000)).toEqual({ startMs: 58_500, endMs: 60_000 });
  });

  describe("API request schemas", () => {
    it("requires a trimmed URL and rejects unexpected fields", () => {
      expect(videoInfoRequestSchema.safeParse({ url: " youtube.com/watch?v=dQw4w9WgXcQ " }).success).toBe(true);
      expect(videoInfoRequestSchema.safeParse({ url: "x", extra: true }).success).toBe(false);
    });
    it("requires explicit rights confirmation and strict clip fields", () => {
      const request = { videoId: "dQw4w9WgXcQ", start: 0, end: 5, framing: "center", rightsConfirmed: true };
      expect(clipRequestSchema.safeParse(request).success).toBe(true);
      expect(clipRequestSchema.safeParse({ ...request, rightsConfirmed: false }).success).toBe(false);
      expect(clipRequestSchema.safeParse({ ...request, extra: "untrusted" }).success).toBe(false);
    });
  });
  it("sanitizes a title to a safe bounded file name", () => {
    expect(sanitizeFilename("../Bad:/title 💥", 12_500, 60_000)).toBe("Badtitle_12.5-60.mp4");
    expect(sanitizeFilename("", 0, 1_000)).toBe("clip_0-1.mp4");
  });
});
