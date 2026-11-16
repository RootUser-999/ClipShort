import { spawn } from "node:child_process";
import { afterAll, expect, it } from "vitest";
import { renderClip, removeJobFiles } from "../src/render.js";

const enabled = process.env.CLIPSHORT_INTEGRATION === "1";
const storage = process.env.CLIP_STORAGE_DIR ?? "/tmp/clipshort-test";
const jobId = "e37320fe-9d62-47fb-850c-4a05f5d2f723";

function probe(file: string): Promise<{ width: number; height: number; videoCodec: string; audioCodec?: string; duration: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", file], { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr));
      const result = JSON.parse(stdout) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>; format: { duration: string } };
      const video = result.streams.find((stream) => stream.codec_type === "video");
      const audio = result.streams.find((stream) => stream.codec_type === "audio");
      if (!video) return reject(new Error("No video stream"));
      resolve({ width: video.width ?? 0, height: video.height ?? 0, videoCodec: video.codec_name, ...(audio ? { audioCodec: audio.codec_name } : {}), duration: Number(result.format.duration) });
    });
  });
}

it.runIf(enabled)("renders a real three-second Creative Commons YouTube section", async () => {
  const file = await renderClip({
    videoId: "aqz-KE-bpKQ",
    start: 5,
    end: 8,
    framing: "center",
    jobId,
    storageDir: storage,
    onProgress: () => undefined,
  });
  const result = await probe(file);
  expect(result).toMatchObject({ width: 1080, height: 1920, videoCodec: "h264" });
  expect(result.audioCodec).toBe("aac");
  expect(result.duration).toBeGreaterThanOrEqual(2.7);
  expect(result.duration).toBeLessThanOrEqual(3.3);
}, 300_000);

afterAll(async () => {
  await removeJobFiles(storage, jobId);
});
