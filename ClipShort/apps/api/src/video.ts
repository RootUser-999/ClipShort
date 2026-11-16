import { spawn } from "node:child_process";
import { InputError, parseYouTubeUrl, type VideoInfo } from "@clipshort/shared";

type YtDlpMetadata = {
  id?: string;
  title?: string;
  duration?: number;
  thumbnail?: string;
  thumbnails?: Array<{ url: string }>;
  channel?: string;
  uploader?: string;
  live_status?: string;
  availability?: string;
  playable_in_embed?: boolean;
};

function run(command: string, args: string[], timeoutMs = 45_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 10_000_000) child.kill("SIGKILL");
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `${command} exited with code ${code}`));
    });
  });
}

export async function fetchVideoInfo(input: string): Promise<VideoInfo> {
  const parsed = parseYouTubeUrl(input);
  const canonicalUrl = `https://www.youtube.com/watch?v=${parsed.videoId}`;
  let raw: string;
  try {
    raw = await run("yt-dlp", [
      "--dump-single-json",
      "--skip-download",
      "--no-warnings",
      "--no-playlist",
      "--no-check-formats",
      canonicalUrl,
    ]);
  } catch (error) {
    const details = error instanceof Error ? error.message : "";
    const message = details.toLowerCase();
    if (message.includes("private video") || message.includes("private")) {
      throw new InputError("This video is private and cannot be clipped.");
    }
    if (message.includes("members-only") || message.includes("join this channel")) {
      throw new InputError("This video is available to channel members only.");
    }
    if (message.includes("age") && (message.includes("restrict") || message.includes("confirm") || message.includes("verif"))) {
      throw new InputError("This age-restricted video cannot be clipped.");
    }
    if (message.includes("sign in to confirm") || message.includes("not a bot")) {
      throw new InputError("YouTube requires verification for this video. Please try another public video.");
    }
    if (message.includes("not available") || message.includes("unavailable") || message.includes("removed")) {
      throw new InputError("This video is unavailable, deleted, or blocked in this region.");
    }
    if (message.includes("copyright") || message.includes("blocked")) {
      throw new InputError("This video is blocked by its owner or copyright restrictions.");
    }
    throw new InputError("We couldn't load this video. Check that it is public and try again.");
  }

  let metadata: YtDlpMetadata;
  try {
    metadata = JSON.parse(raw) as YtDlpMetadata;
  } catch {
    throw new InputError("YouTube returned invalid video information. Please try again.");
  }
  if (metadata.live_status === "is_live" || metadata.live_status === "is_upcoming") {
    throw new InputError("Live streams and upcoming premieres cannot be clipped. Try again after the stream ends.");
  }
  if (metadata.id !== parsed.videoId || !metadata.title || !Number.isFinite(metadata.duration)) {
    throw new InputError("Video information is incomplete or this video cannot be clipped.");
  }
  if (metadata.playable_in_embed === false) {
    throw new InputError("The owner has disabled embedding for this video, so it cannot be clipped here.");
  }
  const maxDuration = Number(process.env.MAX_VIDEO_DURATION ?? 43_200);
  if ((metadata.duration ?? 0) > maxDuration) {
    throw new InputError(`This video is longer than the ${Math.floor(maxDuration / 3600)}-hour limit.`);
  }
  if (metadata.availability && !["public", "unlisted"].includes(metadata.availability)) {
    throw new InputError("This video is not publicly available for clipping.");
  }

  return {
    videoId: parsed.videoId,
    title: metadata.title,
    duration: metadata.duration as number,
    thumbnail: metadata.thumbnail ?? metadata.thumbnails?.at(-1)?.url ?? "",
    channel: metadata.channel ?? metadata.uploader ?? "YouTube creator",
    isLive: false,
    availability: metadata.availability ?? "public",
    ...(parsed.startSeconds === undefined ? {} : { startSeconds: parsed.startSeconds }),
  };
}

export function friendlyProcessingError(error: unknown): string {
  const detail = error instanceof Error ? error.message.toLowerCase() : "";
  if (detail.includes("canceled")) return "Clip creation canceled.";
  if (detail.includes("sign in to confirm") || detail.includes("not a bot")) {
    return "YouTube requires verification for this video. The server owner can configure a cookies file.";
  }
  if (detail.includes("no space left") || detail.includes("disk full")) {
    return "The server is out of storage space. Please try again later.";
  }
  if (detail.includes("timed out") || detail.includes("timeout")) {
    return "Clip creation took too long. Please try a shorter selection.";
  }
  return "We couldn't create this clip. Check that the video is available and try again.";
}

export { run as runProcess };
