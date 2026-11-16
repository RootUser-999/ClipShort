import { spawn } from "node:child_process";
import { mkdir, rm, statfs } from "node:fs/promises";
import path from "node:path";

export type Framing = "center" | "custom" | "blur";

export function buildVideoFilter(framing: Framing, cropX = 0.5): string {
  if (framing === "blur") {
    return "[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:10[blur];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[front];[blur][front]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p";
  }
  if (framing === "custom") {
    const position = Math.max(0, Math.min(1, cropX));
    return `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:x=(iw-1080)*${position.toFixed(4)}:y=(ih-1920)/2,setsar=1,format=yuv420p`;
  }
  return "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p";
}

function execute(command: string, args: string[], onData: (chunk: string) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { shell: false, windowsHide: true });
    let stderr = "";
    process.stdout.setEncoding("utf8").on("data", onData);
    process.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-80_000); onData(chunk); });
    const abort = () => process.kill("SIGKILL");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    process.on("error", (error) => { signal?.removeEventListener("abort", abort); reject(error); });
    process.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error("Clip creation timed out"));
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr}`));
    });
  });
}

export async function checkStorage(storageDir: string): Promise<void> {
  await mkdir(storageDir, { recursive: true });
  const stats = await statfs(storageDir);
  if (stats.bavail * stats.bsize < 1_000_000_000) {
    throw new Error("Insufficient free disk space");
  }
}

export async function renderClip(options: {
  videoId: string;
  start: number;
  end: number;
  framing: Framing;
  cropX?: number;
  jobId: string;
  storageDir: string;
  onProgress: (progress: number) => void;
  onStage?: (status: "downloading" | "rendering", progress: number) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const jobDir = path.join(options.storageDir, options.jobId);
  await mkdir(jobDir, { recursive: true });
  const source = path.join(jobDir, "source.mp4");
  const output = path.join(jobDir, "clip.mp4");
  const sectionStart = Math.max(0, options.start - 2);
  const sectionEnd = options.end + 2;
  const cookieFile = process.env.YTDLP_COOKIES_FILE;
  const downloadArgs = [
    "--no-warnings",
    "--no-playlist",
    "--force-overwrites",
    "--download-sections", `*${sectionStart.toFixed(3)}-${sectionEnd.toFixed(3)}`,
    "--force-keyframes-at-cuts",
    "-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best/bestaudio",
    "--merge-output-format", "mp4",
    "-o", source,
    ...(cookieFile ? ["--cookies", cookieFile] : []),
    "--newline",
    `https://www.youtube.com/watch?v=${options.videoId}`,
  ];
  let downloadOutput = "";
  await execute("yt-dlp", downloadArgs, (chunk) => {
    downloadOutput = (downloadOutput + chunk).slice(-4000);
    const matches = [...downloadOutput.matchAll(/(\d+(?:\.\d+)?)%/g)];
    const percent = matches.length ? Number(matches[matches.length - 1][1]) : 0;
    if (percent > 0) options.onStage?.("downloading", Math.min(34, 3 + Math.floor(percent * 0.3)));
  }, options.signal);
  const duration = options.end - options.start;
  const seek = options.start - sectionStart;
  const filter = buildVideoFilter(options.framing, options.cropX);
  const { audioPresent, videoPresent, frameRate } = await probeMedia(source);
  const audioFilter = audioPresent ? `[${videoPresent ? "0" : "1"}:a]atrim=start=${seek.toFixed(3)}:duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS[aout]` : "";
  const filterComplex = videoPresent
    ? `${filter};${audioFilter}`.replace(/;$/, "")
    : audioFilter;
  const args = [
    "-hide_banner", "-y",
    ...(videoPresent ? ["-i", source] : ["-f", "lavfi", "-i", `color=c=black:s=1080x1920:r=30:d=${duration.toFixed(3)}`, "-i", source]),
    ...(filterComplex ? ["-filter_complex", filterComplex] : []),
    "-map", videoPresent ? "[vout]" : "0:v:0",
    ...(audioPresent ? ["-map", "[aout]"] : []),
    "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
    "-r", String(videoPresent ? Math.min(30, frameRate) : 30), "-fps_mode", "cfr",
    ...(audioPresent ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
    "-t", duration.toFixed(3), "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats", output,
  ];
  args[args.indexOf("-map")] = "-map";
  const filterIndex = args.indexOf("-filter_complex");
  args[filterIndex + 1] = filterComplex.replace(/format=yuv420p$/, "format=yuv420p[vout]");
  let progressOutput = "";
  await execute("ffmpeg", args, (chunk) => {
    progressOutput = (progressOutput + chunk).slice(-4000);
    const matches = [...progressOutput.matchAll(/out_time_ms=(\d+)/g)];
    if (matches.length) {
      const progress = Math.min(99, Math.max(0, Math.floor(Number(matches[matches.length - 1][1]) / 1_000_000 / duration * 100)));
      options.onProgress(35 + Math.floor(progress * 0.64));
      options.onStage?.("rendering", 35 + Math.floor(progress * 0.64));
    }
  }, options.signal);
  await rm(source, { force: true });
  return output;
}

async function probeMedia(file: string): Promise<{ audioPresent: boolean; videoPresent: boolean; frameRate: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,avg_frame_rate", "-of", "json", file], { shell: false, windowsHide: true });
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || "ffprobe failed"));
      try {
        const streams = (JSON.parse(output) as { streams: Array<{ codec_type: string; avg_frame_rate?: string }> }).streams;
        const video = streams.find((stream) => stream.codec_type === "video");
        const [numerator, denominator] = (video?.avg_frame_rate ?? "30/1").split("/").map(Number);
        const measured = denominator ? numerator / denominator : 30;
        resolve({
          audioPresent: streams.some((stream) => stream.codec_type === "audio"),
          videoPresent: Boolean(video),
          frameRate: Number.isFinite(measured) && measured > 0 ? measured : 30,
        });
      } catch {
        reject(new Error("Could not read media stream information"));
      }
    });
  });
}

export async function removeJobFiles(storageDir: string, jobId: string): Promise<void> {
  await rm(path.join(storageDir, jobId), { recursive: true, force: true });
}

