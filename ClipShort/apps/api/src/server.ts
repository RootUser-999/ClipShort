import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import type { RedisReply } from "rate-limit-redis";
import helmet from "helmet";
import { Queue, Worker, type Job } from "bullmq";
import dotenv from "dotenv";
import { Redis } from "ioredis";
import pino from "pino";
import { pinoHttp } from "pino-http";
import {
  clipRequestSchema,
  InputError,
  parseYouTubeUrl,
  sanitizeFilename,
  type ClipStatus,
  type JobSnapshot,
  type VideoInfo,
  videoInfoRequestSchema,
} from "@clipshort/shared";
import { checkStorage, removeJobFiles, renderClip } from "./render.js";
import { fetchVideoInfo, friendlyProcessingError } from "./video.js";

const envCandidates = [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "..", "..", ".env")];
dotenv.config({ path: envCandidates.find(existsSync) });

export const logger = pino({ level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.cookie", "req.headers.authorization"] });
const app = express();
const port = Number(process.env.API_PORT ?? 4000);
const storageDir = process.env.CLIP_STORAGE_DIR ?? "/tmp/clipshort";
const concurrency = Math.max(1, Number(process.env.RENDER_CONCURRENCY ?? 2));
const maxJobDurationMs = Math.max(60_000, Number(process.env.MAX_JOB_DURATION_MS ?? 300_000));
const cache = new Map<string, { info: VideoInfo; expires: number }>();
const jobs = new Map<string, JobSnapshot & { title: string; createdAt: number; info?: ClipJobData }>();
const idempotency = new Map<string, { jobId: string; expires: number }>();
const controllers = new Map<string, AbortController>();

interface ClipJobData {
  videoId: string;
  start: number;
  end: number;
  framing: "center" | "custom" | "blur";
  cropX?: number;
  title: string;
  filename: string;
  duration: number;
  createdAt: number;
  fileSizeBytes?: number;
  status?: ClipStatus;
  error?: string;
}

const redisUrl = process.env.REDIS_URL;
const redisConnection = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: null }) : undefined;
const queue = redisConnection ? new Queue<ClipJobData>("clipshort-render", { connection: redisConnection }) : undefined;

app.set("trust proxy", 1);
app.use(pinoHttp({
  logger,
  genReqId: () => randomUUID(),
  serializers: { req: (req) => ({ id: req.id, method: req.method, url: new URL(req.url ?? "/", "http://localhost").pathname }) },
}));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://s.ytimg.com"],
      frameSrc: ["https://www.youtube.com", "https://www.youtube-nocookie.com"],
      imgSrc: ["'self'", "data:", "https://i.ytimg.com", "https://*.ytimg.com"],
      connectSrc: ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:3000", methods: ["GET", "POST", "DELETE"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "20kb" }));

function limiter(limit: number, windowMs: number, message: string, scope: string) {
  return rateLimit({
    windowMs,
    limit,
    ...(redisConnection ? {
      store: new RedisStore({
        sendCommand: async (...args: string[]): Promise<RedisReply> => {
          if (!args[0]) throw new Error("Redis command is empty");
          const result: unknown = await redisConnection.call(args[0], ...args.slice(1));
          if (typeof result === "string" || typeof result === "number" || typeof result === "boolean") return result;
          if (Array.isArray(result) && result.every((item: unknown) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) return result as RedisReply;
          throw new Error("Redis returned an unsupported rate-limit response");
        },
        prefix: `clipshort:rate:${scope}:`,
      }),
    } : {}),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: message }),
  });
}
const infoLimiter = limiter(Number(process.env.INFO_RATE_LIMIT ?? 10), 60_000, "Too many video checks. Please wait a minute and try again.", "info");
const clipLimiter = limiter(Number(process.env.CLIP_RATE_LIMIT ?? 5), 60 * 60_000, "You've reached the clip creation limit. Please try again later.", "clips");

function setJob(jobId: string, patch: Partial<JobSnapshot & { title: string; createdAt: number; info?: ClipJobData }>) {
  const current = jobs.get(jobId);
  if (current) jobs.set(jobId, { ...current, ...patch });
}

function publicSnapshot(jobId: string): JobSnapshot | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  return {
    jobId,
    status: job.status,
    progress: job.progress,
    ...(job.error ? { error: job.error } : {}),
    ...(job.queuePosition ? { queuePosition: job.queuePosition } : {}),
    ...(job.info?.fileSizeBytes ? { fileSizeBytes: job.info.fileSizeBytes } : {}),
  };
}

async function getSnapshot(jobId: string): Promise<JobSnapshot | undefined> {
  const current = publicSnapshot(jobId);
  if (current) return current;
  const stored = await queue?.getJob(jobId);
  if (!stored) return undefined;
  const state = await stored.getState();
  const status = stored.data.status ?? (state === "completed" ? "ready" : state === "failed" ? "error" : "queued");
  let queuePosition: number | undefined;
  if (state === "waiting" && queue) {
    const waitingJobs = await queue.getWaiting(0, 999);
    const index = waitingJobs.findIndex((entry) => entry.id === jobId);
    if (index >= 0) queuePosition = index + 1;
  }
  return {
    jobId,
    status: status as ClipStatus,
    progress: typeof stored.progress === "number" ? stored.progress : 0,
    ...(stored.data.error ? { error: stored.data.error } : {}),
    ...(stored.data.fileSizeBytes ? { fileSizeBytes: stored.data.fileSizeBytes } : {}),
    ...(queuePosition ? { queuePosition } : {}),
  };
}

async function processClip(jobId: string, data: ClipJobData, workerJob?: Job<ClipJobData>) {
  const update = async (status: ClipStatus, progress: number, error?: string) => {
    setJob(jobId, { status, progress, ...(error ? { error } : {}) });
    if (workerJob) await workerJob.updateData({ ...data, status, ...(error ? { error } : {}) } as ClipJobData & { status: ClipStatus; error?: string });
    if (workerJob) await workerJob.updateProgress(progress);
  };
  const controller = new AbortController();
  controllers.set(jobId, controller);
  const deadline = setTimeout(() => controller.abort(new Error("Clip creation timed out")), maxJobDurationMs);
  deadline.unref();
  try {
    await checkStorage(storageDir);
    await update("downloading", 2);
    const output = await renderClip({
      ...data,
      jobId,
      storageDir,
      signal: controller.signal,
      onProgress: (progress) => { void update("rendering", progress); },
      onStage: (status, progress) => { void update(status, progress); },
    });
    const fileSizeBytes = (await stat(output)).size;
    const currentJob = jobs.get(jobId);
    if (currentJob?.info) currentJob.info.fileSizeBytes = fileSizeBytes;
    data.fileSizeBytes = fileSizeBytes;
    if (workerJob) await workerJob.updateData({ ...data, status: "ready" });
    await update("ready", 100);
  } catch (error) {
    const readable = friendlyProcessingError(error);
    logger.error({ err: error, jobId }, "Clip processing failed");
    await removeJobFiles(storageDir, jobId).catch((cleanupError) => logger.error({ err: cleanupError, jobId }, "Failed to clean failed job"));
    await update("error", 0, readable);
  } finally {
    controllers.delete(jobId);
    clearTimeout(deadline);
  }
}

const waiting: Array<{ jobId: string; data: ClipJobData }> = [];
let active = 0;
function startMemoryJob(jobId: string, data: ClipJobData) {
  waiting.push({ jobId, data });
  waiting.forEach((item, index) => setJob(item.jobId, { queuePosition: index + 1 }));
  void drainMemoryQueue();
}
async function drainMemoryQueue() {
  while (active < concurrency && waiting.length) {
    const item = waiting.shift();
    if (!item) return;
    active++;
    waiting.forEach((entry, index) => setJob(entry.jobId, { queuePosition: index + 1 }));
    void processClip(item.jobId, item.data).finally(() => {
      active--;
      drainMemoryQueue();
    });
  }
}

if (redisConnection && queue) {
  const worker = new Worker<ClipJobData>("clipshort-render", async (job) => {
    setJob(job.id!, { status: "downloading", progress: 1 });
    await processClip(job.id!, job.data, job);
    const status = publicSnapshot(job.id!)?.status;
    if (status === "error") throw new Error(publicSnapshot(job.id!)?.error ?? "Clip rendering failed");
  }, { connection: redisConnection, concurrency });
  worker.on("failed", (job, error) => {
    if (job) {
      setJob(job.id!, { status: "error", progress: 0, error: friendlyProcessingError(error) });
      void job.updateData({ ...job.data, status: "error", error: friendlyProcessingError(error) });
    }
    logger.error({ err: error, jobId: job?.id }, "Render worker failed");
  });
  worker.on("error", (error) => logger.error({ err: error }, "Render worker error"));
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", queue: queue ? "redis" : "memory" }));

app.post("/api/video/info", infoLimiter, async (req, res) => {
  const parsedBody = videoInfoRequestSchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "Enter a YouTube video URL." });
    return;
  }
  try {
    const parsedUrl = parseYouTubeUrl(parsedBody.data.url);
    const { videoId } = parsedUrl;
    const cached = cache.get(videoId);
    const info = cached && cached.expires > Date.now() ? cached.info : await fetchVideoInfo(parsedBody.data.url);
    const { startSeconds: _cachedTimestamp, ...baseInfo } = info;
    cache.set(videoId, { info: baseInfo, expires: Date.now() + 10 * 60_000 });
    res.json({ ...baseInfo, ...(parsedUrl.startSeconds === undefined ? {} : { startSeconds: parsedUrl.startSeconds }) });
  } catch (error) {
    const message = error instanceof InputError ? error.message : "We couldn't load this video. Please check the link and try again.";
    if (!(error instanceof InputError)) logger.error({ err: error, requestId: req.id }, "Video metadata lookup failed");
    res.status(400).json({ error: message });
  }
});

app.post("/api/clips", clipLimiter, async (req, res) => {
  const parsed = clipRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Check the clip selection and confirm you have permission to use this video." });
    return;
  }
  const request = parsed.data;
  if (process.env.TURNSTILE_ENABLED === "true") {
    if (!request.turnstileToken || !process.env.TURNSTILE_SECRET_KEY) {
      res.status(400).json({ error: "Please complete the verification challenge." });
      return;
    }
    try {
      const body = new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET_KEY,
        response: request.turnstileToken,
        ...(req.ip ? { remoteip: req.ip } : {}),
      });
      const verification = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
      const result = await verification.json() as { success?: boolean };
      if (!result.success) {
        res.status(400).json({ error: "Verification failed. Please try again." });
        return;
      }
    } catch (error) {
      logger.error({ err: error, requestId: req.id }, "Turnstile verification failed");
      res.status(503).json({ error: "Verification is temporarily unavailable." });
      return;
    }
  }
  const startMs = Math.round(request.start * 1000);
  const endMs = Math.round(request.end * 1000);
  if (startMs < 0 || endMs <= startMs || endMs - startMs > 60_000 || endMs - startMs < 1_000) {
    res.status(400).json({ error: "Choose a clip between 1 and 60 seconds long." });
    return;
  }
  const signature = `${req.ip}:${request.videoId}:${startMs}:${endMs}:${request.framing}:${request.cropX ?? ""}`;
  const previous = idempotency.get(signature);
  if (previous && previous.expires > Date.now()) {
    res.status(202).json({ jobId: previous.jobId });
    return;
  }
  const jobId = randomUUID();
  idempotency.set(signature, { jobId, expires: Date.now() + 10_000 });
  const createdAt = Date.now();
  jobs.set(jobId, { jobId, status: "queued", progress: 0, title: "Preparing clip", createdAt, queuePosition: 1 });
  try {
    let info = cache.get(request.videoId)?.info;
    if (!info) {
      info = await fetchVideoInfo(`https://www.youtube.com/watch?v=${request.videoId}`);
      cache.set(request.videoId, { info, expires: Date.now() + 10 * 60_000 });
    }
    if (endMs > Math.round(info.duration * 1000)) {
      res.status(400).json({ error: "The selected end time is past the end of the video." });
      return;
    }
    const start = startMs / 1000;
    const end = endMs / 1000;
    const data: ClipJobData = {
      videoId: request.videoId, start, end, framing: request.framing, cropX: request.cropX,
      title: info.title, filename: sanitizeFilename(info.title, startMs, endMs),
      duration: end - start, createdAt: Date.now(),
    };
    await checkStorage(storageDir);
    jobs.set(jobId, { jobId, status: "queued", progress: 0, title: info.title, createdAt: data.createdAt, info: data, queuePosition: waiting.length + active + 1 });
    if (queue) {
      await queue.add("render", data, { jobId, removeOnComplete: false, removeOnFail: false });
    } else {
      startMemoryJob(jobId, data);
    }
    res.status(202).json({ jobId });
  } catch (error) {
    if (idempotency.get(signature)?.jobId === jobId) idempotency.delete(signature);
    logger.error({ err: error, requestId: req.id }, "Could not queue clip");
    const message = error instanceof InputError ? error.message : "The server is temporarily unable to create this clip.";
    setJob(jobId, { status: "error", progress: 0, error: message });
    res.status(400).json({ error: message });
  }
});

app.delete("/api/clips/:jobId", async (req, res) => {
  const jobId = req.params.jobId;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    res.status(404).json({ error: "Clip job not found." });
    return;
  }
  const queuedIndex = waiting.findIndex((item) => item.jobId === jobId);
  if (queuedIndex >= 0) {
    waiting.splice(queuedIndex, 1);
    setJob(jobId, { status: "error", progress: 0, error: "Clip creation canceled." });
    await removeJobFiles(storageDir, jobId);
    res.json({ canceled: true });
    return;
  }
  const stored = await queue?.getJob(jobId);
  if (stored) {
    const state = await stored.getState();
    if (state === "waiting" || state === "delayed") {
      await stored.remove();
      setJob(jobId, { status: "error", progress: 0, error: "Clip creation canceled." });
      await removeJobFiles(storageDir, jobId);
      res.json({ canceled: true });
      return;
    }
  }
  const controller = controllers.get(jobId);
  if (controller) {
    controller.abort(new Error("Clip creation canceled"));
    res.status(202).json({ canceled: true });
    return;
  }
  if (publicSnapshot(jobId)?.status === "queued" && !stored) {
    setJob(jobId, { status: "error", progress: 0, error: "Clip creation canceled." });
    res.json({ canceled: true });
    return;
  }
  res.status(409).json({ error: "This clip is no longer waiting to be canceled." });
});

app.get("/api/clips/:jobId/events", async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.jobId)) {
    res.status(404).json({ error: "This clip expired, please create it again." });
    return;
  }
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  let closed = false;
  const send = async () => {
    const snapshot = await getSnapshot(req.params.jobId);
    if (!snapshot) {
      res.write(`event: status\ndata: ${JSON.stringify({ jobId: req.params.jobId, status: "error", progress: 0, error: "This clip expired, please create it again." })}\n\n`);
      res.end();
      closed = true;
      return;
    }
    res.write(`event: status\ndata: ${JSON.stringify(snapshot)}\n\n`);
    if (snapshot.status === "ready" || snapshot.status === "error") {
      res.write("event: done\ndata: {}\n\n");
      res.end();
      closed = true;
    }
  };
  await send();
  const interval = setInterval(() => { if (!closed) void send(); }, 1000);
  req.on("close", () => { closed = true; clearInterval(interval); });
});

app.get("/api/clips/:jobId/download", async (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  const stored = job ? undefined : await queue?.getJob(jobId);
  const data = job?.info ?? stored?.data;
  const status = job?.status ?? (stored ? await stored.getState() : undefined);
  if (!data || status !== "ready" && status !== "completed") {
    res.status(404).json({ error: "This clip expired, please create it again." });
    return;
  }
  if (Date.now() - data.createdAt > 30 * 60_000) {
    await removeJobFiles(storageDir, jobId);
    jobs.delete(jobId);
    await stored?.remove();
    res.status(404).json({ error: "This clip expired, please create it again." });
    return;
  }
  const file = path.join(storageDir, jobId, "clip.mp4");
  if (!existsSync(file)) {
    res.status(404).json({ error: "This clip expired, please create it again." });
    return;
  }
  res.download(file, data.filename);
});

async function cleanupExpired() {
  try {
    await mkdir(storageDir, { recursive: true });
    const now = Date.now();
    for (const name of await readdir(storageDir)) {
      if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
      const directory = path.join(storageDir, name);
      const details = await stat(directory).catch(() => undefined);
      const record = jobs.get(name);
      if (details && now - details.mtimeMs > 30 * 60_000 || record && now - record.createdAt > 30 * 60_000) {
        await rm(directory, { recursive: true, force: true });
        jobs.delete(name);
        await queue?.getJob(name).then((job) => job?.remove()).catch((error) => logger.warn({ err: error }, "Could not remove expired queue job"));
      }
    }
    for (let index = waiting.length - 1; index >= 0; index--) {
      const item = waiting[index];
      if (item && now - item.data.createdAt > 30 * 60_000) {
        waiting.splice(index, 1);
        setJob(item.jobId, { status: "error", progress: 0, error: "This clip expired, please create it again." });
      }
    }
    for (const [key, value] of idempotency) if (value.expires < now) idempotency.delete(key);
    for (const [key, value] of cache) if (value.expires < now) cache.delete(key);
    for (const [key, value] of jobs) {
      if (now - value.createdAt > 30 * 60_000 && !controllers.has(key)) jobs.delete(key);
    }
    if (queue) {
      const storedJobs = await queue.getJobs(["waiting", "delayed", "completed", "failed"], 0, 999);
      for (const stored of storedJobs) {
        if (stored.data.createdAt && now - stored.data.createdAt > 30 * 60_000) {
          setJob(stored.id!, { status: "error", progress: 0, error: "This clip expired, please create it again." });
          await stored.remove();
        }
      }
    }
  } catch (error) {
    logger.error({ err: error }, "Clip cleanup failed");
  }
}

app.use((error: unknown, req: Request, res: Response, _next: express.NextFunction) => {
  const status = error && typeof error === "object"
    ? ("status" in error && typeof error.status === "number" ? error.status : "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined)
    : undefined;
  if (error instanceof SyntaxError && status === 400) {
    res.status(400).json({ error: "Request body must be valid JSON." });
    return;
  }
  if (status === 413) {
    res.status(413).json({ error: "Request body is too large." });
    return;
  }
  const detail = error instanceof Error ? { name: error.name, message: error.message } : { message: "Unknown error" };
  logger.error({ err: detail, requestId: req.id }, "Unhandled API error");
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

await mkdir(storageDir, { recursive: true });
await cleanupExpired();
setInterval(() => void cleanupExpired(), 10 * 60_000).unref();
const server = app.listen(port, () => logger.info({ port, queue: queue ? "redis" : "memory", storageDir }, "ClipShort API listening"));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void queue?.close();
      void redisConnection?.quit();
      process.exit(0);
    });
  });
}
