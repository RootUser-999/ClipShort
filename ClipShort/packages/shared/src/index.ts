import { z } from "zod";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function parseTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const raw = value.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?s?$/.test(raw)) return Number.parseFloat(raw);
  const units = raw.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (units && units[0] && (units[1] || units[2] || units[3])) {
    return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  }
  if (/^\d{1,2}:\d{1,2}(?::\d{1,2})?$/.test(raw)) {
    return raw.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
  }
  return undefined;
}

export function parseYouTubeUrl(input: string): { videoId: string; startSeconds?: number } {
  const trimmed = input.trim();
  if (!trimmed) throw new InputError("Paste a YouTube video link to continue.");
  if (/^(?:javascript|file|data):/i.test(trimmed)) {
    throw new InputError("That link is not a valid YouTube video URL.");
  }

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new InputError("Enter a valid YouTube video URL.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!YOUTUBE_HOSTS.has(host) || url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new InputError("Only YouTube video links are supported.");
  }

  let videoId: string | undefined;
  if (host === "youtu.be" || host === "www.youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0];
  } else if (url.pathname === "/watch") {
    videoId = url.searchParams.get("v") ?? undefined;
  } else {
    const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/);
    videoId = match?.[1];
  }
  if (!videoId || !VIDEO_ID.test(videoId)) {
    throw new InputError("That link does not contain a valid YouTube video.");
  }
  const startSeconds = parseTimestamp(url.searchParams.get("t") ?? url.searchParams.get("start"));
  return { videoId, ...(startSeconds === undefined ? {} : { startSeconds }) };
}

export function clampSelection(startMs: number, endMs: number, durationMs: number) {
  const duration = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
  const minimumLength = Math.min(1_000, duration);
  const maximumLength = Math.min(60_000, duration);
  const requestedStart = Number.isFinite(startMs) ? Math.round(startMs) : 0;
  const requestedEnd = Number.isFinite(endMs) ? Math.round(endMs) : requestedStart + minimumLength;
  const start = Math.max(0, Math.min(requestedStart, duration - minimumLength));
  const requestedLength = requestedEnd - start;
  const length = Math.max(minimumLength, Math.min(maximumLength, requestedLength));
  const boundedStart = Math.max(0, Math.min(start, duration - length));
  const end = boundedStart + length;
  return { startMs: boundedStart, endMs: end };
}

export function sanitizeFilename(title: string, startMs: number, endMs: number): string {
  const cleanTitle = title
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[\x00-\x1F\x7F<>:"/\\|?*]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "")
    .slice(0, 100) || "clip";
  const format = (ms: number) => (Math.max(0, Math.round(ms)) / 1000).toFixed(3).replace(/\.?0+$/, "");
  return `${cleanTitle}_${format(startMs)}-${format(endMs)}.mp4`;
}

export const clipRequestSchema = z.object({
  videoId: z.string().regex(VIDEO_ID),
  start: z.number().finite(),
  end: z.number().finite(),
  framing: z.enum(["center", "custom", "blur"]),
  cropX: z.number().min(0).max(1).optional(),
  rightsConfirmed: z.literal(true),
  turnstileToken: z.string().max(4096).optional(),
}).strict();

export const videoInfoRequestSchema = z.object({
  url: z.string().trim().min(1).max(2048),
}).strict();

export type ClipRequest = z.infer<typeof clipRequestSchema>;
export type ClipStatus = "queued" | "downloading" | "rendering" | "ready" | "error";
export interface VideoInfo {
  videoId: string;
  title: string;
  duration: number;
  thumbnail: string;
  channel: string;
  isLive: boolean;
  availability: string;
  startSeconds?: number;
}
export interface JobSnapshot {
  jobId: string;
  status: ClipStatus;
  progress: number;
  error?: string;
  queuePosition?: number;
  fileSizeBytes?: number;
}
