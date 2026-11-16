"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipStatus, JobSnapshot, VideoInfo } from "@clipshort/shared";

declare global {
  interface Window {
    YT?: {
      Player: new (id: string, options: {
        events: {
          onReady: (event: { target: Player }) => void;
          onStateChange: (event: { data: number }) => void;
        };
      }) => Player;
    };
    turnstile?: {
      render: (element: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "expired-callback": () => void }) => string;
      reset: (id?: string) => void;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}
interface Player {
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
}
type Framing = "center" | "custom" | "blur";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function parseTime(value: string): number | undefined {
  if (!/^\d{1,3}:\d{1,2}(?::\d{1,2})?$/.test(value.trim())) return undefined;
  return value.split(":").reduce((acc, item) => acc * 60 + Number(item), 0);
}
function formatBytes(bytes?: number): string {
  if (!bytes) return "Size unavailable";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function isVideoInfo(value: unknown): value is VideoInfo {
  if (!value || typeof value !== "object") return false;
  const info = value as Partial<VideoInfo>;
  return typeof info.videoId === "string" && /^[A-Za-z0-9_-]{11}$/.test(info.videoId)
    && typeof info.title === "string" && Number.isFinite(info.duration)
    && typeof info.thumbnail === "string" && typeof info.channel === "string";
}
function fitSelection(start: number, end: number, duration: number, fixed?: "start" | "end"): [number, number] {
  const maxDuration = Math.max(0, duration);
  if (fixed === "end") {
    const fixedEnd = Math.max(1, Math.min(end, maxDuration));
    const newStart = Math.max(Math.max(0, fixedEnd - 60), Math.min(start, fixedEnd - 1));
    return [newStart, fixedEnd];
  }
  if (fixed === "start") {
    const fixedStart = Math.max(0, Math.min(start, maxDuration - 1));
    return [fixedStart, Math.max(fixedStart + 1, Math.min(end, maxDuration, fixedStart + 60))];
  }
  const length = Math.max(1, Math.min(60, end - start, maxDuration));
  const movedStart = Math.max(0, Math.min(start, maxDuration - length));
  return [movedStart, movedStart + length];
}

export default function ClipShort() {
  const [url, setUrl] = useState("");
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(60_000);
  const [startText, setStartText] = useState("0:00");
  const [endText, setEndText] = useState("1:00");
  const [framing, setFraming] = useState<Framing>("center");
  const [cropX, setCropX] = useState(0.5);
  const [loop, setLoop] = useState(false);
  const [rights, setRights] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [dark, setDark] = useState(false);
  const turnstileWidgetRef = useRef<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const cropRef = useRef<HTMLDivElement>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const eventRef = useRef<EventSource | null>(null);
  const creatingRef = useRef(false);
  const pointerRef = useRef<{ id: number; mode: "move" | "start" | "end"; origin: number; start: number; end: number } | null>(null);
  const cropPointerRef = useRef<number | null>(null);
  const selectionStart = startMs / 1000;
  const selectionEnd = endMs / 1000;
  const duration = video?.duration ?? 0;
  const currentVideoId = video?.videoId;
  const length = Math.max(0, selectionEnd - selectionStart);
  const startPercent = duration ? selectionStart / duration * 100 : 0;
  const endPercent = duration ? selectionEnd / duration * 100 : 0;

  const updateSelection = useCallback((start: number, end: number, fixed?: "start" | "end") => {
    if (!duration) return;
    const [a, b] = fitSelection(start, end, duration, fixed);
    const aMs = Math.round(a * 1000);
    const bMs = Math.round(b * 1000);
    setStartMs(aMs);
    setEndMs(bMs);
    setStartText(formatTime(a));
    setEndText(formatTime(b));
    if (video) {
      try {
        localStorage.setItem("clipshort-range", JSON.stringify({ startMs: aMs, endMs: bMs }));
      } catch {
        setError("Browser storage is unavailable; your selection may not survive a refresh.");
      }
    }
  }, [duration, video]);

  const attachEvents = useCallback((jobId: string) => {
    eventRef.current?.close();
    const source = new EventSource(`${API}/api/clips/${jobId}/events`);
    eventRef.current = source;
    source.addEventListener("status", (event) => {
      const current = JSON.parse((event as MessageEvent).data) as JobSnapshot;
      setJob(current);
      if (current.status === "ready" || current.status === "error") {
        source.close();
      }
    });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const savedAt = Number(localStorage.getItem("clipshort-state-time") ?? 0);
        if (savedAt && Date.now() - savedAt < 30 * 60_000) {
          const videoValue: unknown = JSON.parse(localStorage.getItem("clipshort-video") ?? "null");
          if (isVideoInfo(videoValue)) {
            setVideo(videoValue);
            const rangeValue: unknown = JSON.parse(localStorage.getItem("clipshort-range") ?? "null");
            if (rangeValue && typeof rangeValue === "object") {
              const range = rangeValue as { startMs?: unknown; endMs?: unknown };
              if (typeof range.startMs === "number" && typeof range.endMs === "number") {
                const start = Math.max(0, Math.min(range.startMs / 1000, videoValue.duration - 1));
                const end = Math.max(start + 1, Math.min(range.endMs / 1000, videoValue.duration, start + 60));
                setStartMs(Math.round(start * 1000));
                setEndMs(Math.round(end * 1000));
                setStartText(formatTime(start));
                setEndText(formatTime(end));
              }
            }
            const savedFraming = localStorage.getItem("clipshort-framing");
            if (savedFraming === "center" || savedFraming === "custom" || savedFraming === "blur") setFraming(savedFraming);
            const savedCrop = Number(localStorage.getItem("clipshort-crop-x"));
            if (Number.isFinite(savedCrop)) setCropX(Math.max(0, Math.min(1, savedCrop)));
          }
        } else {
          ["clipshort-job", "clipshort-job-created", "clipshort-video", "clipshort-range", "clipshort-state-time"].forEach((key) => localStorage.removeItem(key));
        }
        const savedJob = localStorage.getItem("clipshort-job");
        if (savedJob) attachEvents(savedJob);
      } catch {
        setError("Saved editor state could not be restored.");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [attachEvents]);

  useEffect(() => {
    if (!video) return;
    try {
      localStorage.setItem("clipshort-state-time", String(Date.now()));
      localStorage.setItem("clipshort-framing", framing);
      localStorage.setItem("clipshort-crop-x", String(cropX));
    } catch {
      window.setTimeout(() => setError("Browser storage is unavailable; editor state may not survive a refresh."), 0);
    }
  }, [cropX, framing, startMs, endMs, video]);

  useEffect(() => () => eventRef.current?.close(), []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    if (!siteKey || !turnstileRef.current) return;
    const scriptId = "cloudflare-turnstile";
    let script = document.getElementById(scriptId) as HTMLScriptElement | null;
    const renderWidget = () => {
      if (!window.turnstile || !turnstileRef.current || turnstileWidgetRef.current) return;
      turnstileWidgetRef.current = window.turnstile.render(turnstileRef.current, {
        sitekey: siteKey,
        callback: setTurnstileToken,
        "expired-callback": () => setTurnstileToken(""),
      });
    };
    if (window.turnstile) renderWidget();
    else {
      if (!script) {
        script = document.createElement("script");
        script.id = scriptId;
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.onload = renderWidget;
        document.head.appendChild(script);
      } else script.addEventListener("load", renderWidget, { once: true });
    }
    return () => {
      turnstileWidgetRef.current = null;
      setTurnstileToken("");
    };
  }, [video?.videoId]);

  useEffect(() => {
    if (!currentVideoId) return;
    const scriptId = "youtube-iframe-api";
    let script = document.getElementById(scriptId) as HTMLScriptElement | null;
    const createPlayer = () => {
      if (!window.YT || !document.getElementById("youtube-player")) return;
      playerRef.current = new window.YT.Player("youtube-player", {
        events: {
          onReady: (event) => {
            playerRef.current = event.target;
          },
          onStateChange: (event) => setIsPlaying(event.data === 1),
        },
      });
    };
    if (window.YT?.Player) createPlayer();
    else {
      window.onYouTubeIframeAPIReady = createPlayer;
      if (!script) {
        script = document.createElement("script");
        script.id = scriptId;
        script.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(script);
      }
    }
    return () => {
      playerRef.current = null;
      window.onYouTubeIframeAPIReady = undefined;
    };
  }, [currentVideoId]);

  useEffect(() => {
    if (!isPlaying || !playerRef.current || !video) return;
    const timer = window.setInterval(() => {
      const now = playerRef.current?.getCurrentTime() ?? 0;
      if (now >= selectionEnd) {
        if (loop) playerRef.current?.seekTo(selectionStart, true);
        else playerRef.current?.pauseVideo();
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [isPlaying, loop, selectionEnd, selectionStart, video]);

  const loadVideo = async (event?: React.FormEvent) => {
    event?.preventDefault();
    setError("");
    setJob(null);
    eventRef.current?.close();
    try {
      ["clipshort-job", "clipshort-job-created", "clipshort-video", "clipshort-range", "clipshort-state-time"].forEach((key) => localStorage.removeItem(key));
    } catch {
      setError("Browser storage could not be cleared; the previous editor may be restored after refresh.");
    }
    setVideo(null);
    setTurnstileToken("");
    if (!url.trim()) {
      setError("Paste a YouTube link to get started.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`${API}/api/video/info`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: url.trim() }),
      });
      const result = await response.json() as VideoInfo & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "We couldn't load this video.");
      setVideo(result);
      try {
        localStorage.setItem("clipshort-video", JSON.stringify(result));
        localStorage.setItem("clipshort-state-time", String(Date.now()));
      } catch {
        setError("Browser storage is unavailable; refreshing may lose the current editor state.");
      }
      const initial = Math.min(result.startSeconds ?? 0, Math.max(0, result.duration - 1));
      const initialEnd = Math.min(result.duration, initial + 60);
      setStartMs(Math.round(initial * 1000));
      setEndMs(Math.round(initialEnd * 1000));
      try {
        localStorage.setItem("clipshort-range", JSON.stringify({ startMs: Math.round(initial * 1000), endMs: Math.round(initialEnd * 1000) }));
      } catch {
        setError("Browser storage is unavailable; refreshing may lose the current editor state.");
      }
      setStartText(formatTime(initial));
      setEndText(formatTime(initialEnd));
      setRights(false);
      setFraming("center");
      setCropX(0.5);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "We couldn't load this video.");
    } finally {
      setLoading(false);
    }
  };

  const locatePointer = (event: React.PointerEvent, mode: "move" | "start" | "end") => {
    if (!duration || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const position = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * duration;
    pointerRef.current = { id: event.pointerId, mode, origin: position, start: selectionStart, end: selectionEnd };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const movePointer = (event: React.PointerEvent) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const position = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * duration;
    const delta = position - pointer.origin;
    if (pointer.mode === "move") updateSelection(pointer.start + delta, pointer.end + delta);
    else if (pointer.mode === "start") updateSelection(position, pointer.end, "end");
    else updateSelection(pointer.start, position, "start");
  };

  const handleKeyboard = (event: React.KeyboardEvent) => {
    if (event.code === "Space") {
      event.preventDefault();
      if (playerRef.current?.getPlayerState() === 1) playerRef.current.pauseVideo();
      else playerRef.current?.playVideo();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 5 : 1);
      updateSelection(selectionStart + delta, selectionEnd + delta);
    }
  };

  const editTime = (which: "start" | "end", value: string) => {
    const seconds = parseTime(value);
    if (which === "start") setStartText(value);
    else setEndText(value);
    if (seconds === undefined) {
      setError("Enter a time in mm:ss or hh:mm:ss format.");
      return;
    }
    setError("");
    const other = which === "start" ? selectionEnd : selectionStart;
    if (which === "start") updateSelection(seconds, other, "end");
    else updateSelection(other, seconds, "start");
  };

  const previewSelection = () => {
    if (!playerRef.current) return;
    playerRef.current.seekTo(selectionStart, true);
    playerRef.current.playVideo();
  };

  const createClip = async () => {
    if (!video || !rights || creatingRef.current || job?.status === "queued" || job?.status === "downloading" || job?.status === "rendering") return;
    creatingRef.current = true;
    setError("");
    try {
      const response = await fetch(`${API}/api/clips`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: video.videoId, start: startMs / 1000, end: endMs / 1000,
          framing, cropX, rightsConfirmed: rights, ...(turnstileToken ? { turnstileToken } : {}),
        }),
      });
      const result = await response.json() as { jobId?: string; error?: string };
      if (!response.ok || !result.jobId) throw new Error(result.error ?? "Couldn't start your clip.");
      try {
        localStorage.setItem("clipshort-job", result.jobId);
        localStorage.setItem("clipshort-job-created", String(Date.now()));
        localStorage.setItem("clipshort-state-time", String(Date.now()));
      } catch {
        setError("The clip has started, but browser storage is unavailable; keep this tab open to follow it.");
      }
      setJob({ jobId: result.jobId, status: "queued", progress: 0, queuePosition: 1 });
      attachEvents(result.jobId);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Couldn't start your clip.");
    } finally {
      creatingRef.current = false;
    }
  };

  const startNewVideo = () => {
    if (job && ["queued", "downloading", "rendering"].includes(job.status)) {
      void fetch(`${API}/api/clips/${job.jobId}`, { method: "DELETE" })
        .then((response) => { if (!response.ok) setError("The clip job could not be canceled. It may still finish in the background."); })
        .catch(() => setError("The clip job could not be canceled. It may still finish in the background."));
    }
    setVideo(null);
    setUrl("");
    setJob(null);
    setRights(false);
    setTurnstileToken("");
    eventRef.current?.close();
    try {
      ["clipshort-job", "clipshort-job-created", "clipshort-video", "clipshort-range", "clipshort-state-time"].forEach((key) => localStorage.removeItem(key));
    } catch {
      setError("Browser storage could not be cleared; the previous editor may be restored after refresh.");
    }
    setFraming("center");
    setCropX(0.5);
  };

  const dragCrop = (event: React.PointerEvent) => {
    if (!cropRef.current) return;
    cropPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const update = (clientX: number) => {
      const rect = cropRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCropX(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
    };
    update(event.clientX);
  };
  const updateCrop = (event: React.PointerEvent) => {
    if (cropPointerRef.current === event.pointerId) dragCrop(event);
  };

  const busy = job?.status === "queued" || job?.status === "downloading" || job?.status === "rendering";
  const stageNames: ClipStatus[] = ["queued", "downloading", "rendering", "ready"];
  const stageLabels = ["Queued", "Downloading", "Rendering", "Ready"];
  const stageIndex = job ? stageNames.indexOf(job.status) : -1;

  return (
    <main className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Link href="/" className="flex items-center gap-2 text-xl font-black tracking-tight"><span className="grid h-9 w-9 place-items-center rounded-xl bg-violet-600 text-white">C</span>ClipShort</Link>
        <div className="flex items-center gap-4 text-sm">
          <nav className="hidden gap-4 sm:flex"><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link><Link href="/dmca">DMCA</Link></nav>
          <button onClick={() => setDark(!dark)} className="surface rounded-full border bg-white px-3 py-2" aria-label="Toggle dark mode">{dark ? "☀️" : "🌙"}</button>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-5 pb-12 pt-6">
        {!video ? (
          <div className="mx-auto max-w-3xl pt-12 text-center sm:pt-20">
            <div className="mb-5 inline-flex rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-bold uppercase tracking-wider text-violet-700">Made for vertical video</div>
            <h1 className="text-4xl font-black leading-tight tracking-tight sm:text-6xl">Make every moment<br className="hidden sm:block" /> a <span className="text-violet-600">short.</span></h1>
            <p className="mx-auto mt-5 max-w-xl text-lg text-slate-600">Turn a YouTube video into a vertical clip for Shorts, Reels, and TikTok. Pick the moment, choose your frame, and download.</p>
            <form onSubmit={loadVideo} className="surface mt-9 flex flex-col gap-3 rounded-2xl border bg-white p-3 shadow-soft sm:flex-row">
              <label className="sr-only" htmlFor="youtube-url">YouTube video URL</label>
              <input id="youtube-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a YouTube link..." className="min-w-0 flex-1 rounded-xl px-4 py-3 outline-none" type="text" inputMode="url" aria-invalid={Boolean(error)} />
              <button disabled={loading} className="rounded-xl bg-violet-600 px-6 py-3 font-bold text-white disabled:opacity-60">{loading ? "Loading video..." : "Load video"}</button>
            </form>
            {error && <p role="alert" className="mt-3 text-left text-sm text-red-600">{error}</p>}
            <div className="mt-14 grid gap-5 text-left sm:grid-cols-3">
              {[["01", "Drop a link", "Paste any public YouTube video link."], ["02", "Pick your moment", "Select up to 60 seconds and frame your shot."], ["03", "Download & share", "Get a vertical MP4, ready to post."]].map(([number, title, copy]) => (
                <article key={number} className="surface rounded-2xl border bg-white p-5 shadow-soft"><span className="text-sm font-bold text-violet-600">{number}</span><h2 className="mt-3 font-bold">{title}</h2><p className="muted mt-2 text-sm text-slate-500">{copy}</p></article>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(280px,.8fr)]">
            <div className="space-y-5">
              <div className="surface overflow-hidden rounded-2xl border bg-white shadow-soft">
                <div className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0"><h1 className="truncate font-bold">{video.title}</h1><p className="muted mt-1 text-sm text-slate-500">{video.channel} · {formatTime(duration)}</p></div>
                  <button className="shrink-0 rounded-lg border px-3 py-2 text-sm" onClick={startNewVideo}>New video</button>
                </div>
                <div className="aspect-video bg-black">
                  <iframe id="youtube-player" title="YouTube video preview" className="h-full w-full" src={`https://www.youtube.com/embed/${video.videoId}?enablejsapi=1&origin=${encodeURIComponent(typeof window !== "undefined" ? window.location.origin : "")}`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen />
                </div>
              </div>

              <section className="surface rounded-2xl border bg-white p-5 shadow-soft">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div><h2 className="font-bold">Choose your moment</h2><p className="muted mt-1 text-sm text-slate-500">Drag the range or use arrow keys to fine-tune.</p></div>
                  <button onClick={previewSelection} className="rounded-lg border px-3 py-2 text-sm font-semibold">▶ Preview selection</button>
                </div>
                <div ref={trackRef} className="range-track relative my-8 h-12 cursor-pointer rounded-lg bg-slate-200" onPointerMove={movePointer} onPointerUp={() => { pointerRef.current = null; }} onPointerCancel={() => { pointerRef.current = null; }} onKeyDown={handleKeyboard} tabIndex={0} role="group" aria-label="Video selection timeline">
                  <div className="absolute inset-0 rounded-lg opacity-30" style={{ backgroundImage: `linear-gradient(to right, transparent, rgba(99,80,240,.3)), url(${video.thumbnail})`, backgroundPosition: "center", backgroundSize: "cover" }} />
                  <div className="absolute inset-y-0 rounded-md border-2 border-violet-600 bg-violet-500/30" style={{ left: `${startPercent}%`, width: `${Math.max(0, endPercent - startPercent)}%` }} onPointerDown={(e) => locatePointer(e, "move")} />
                  <div className="range-handle absolute inset-y-[-7px] z-10 w-5 -translate-x-1/2 cursor-ew-resize rounded-md border-2 border-white bg-violet-600 shadow" style={{ left: `${startPercent}%` }} role="slider" aria-label="Clip start" aria-valuemin={0} aria-valuemax={Math.max(0, duration - 1)} aria-valuenow={selectionStart} tabIndex={0} onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); const next = selectionStart + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 5 : 1); updateSelection(next, selectionEnd, "end"); } }} onPointerDown={(e) => { e.stopPropagation(); locatePointer(e, "start"); }} />
                  <div className="range-handle absolute inset-y-[-7px] z-10 w-5 -translate-x-1/2 cursor-ew-resize rounded-md border-2 border-white bg-violet-600 shadow" style={{ left: `${endPercent}%` }} role="slider" aria-label="Clip end" aria-valuemin={selectionStart + 1} aria-valuemax={duration} aria-valuenow={selectionEnd} tabIndex={0} onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); const next = selectionEnd + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 5 : 1); updateSelection(selectionStart, next, "start"); } }} onPointerDown={(e) => { e.stopPropagation(); locatePointer(e, "end"); }} />
                </div>
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div className="flex gap-3">
                    <label className="text-xs font-semibold text-slate-500">START<input value={startText} onChange={(e) => editTime("start", e.target.value)} onBlur={() => setStartText(formatTime(selectionStart))} className="surface mt-1 block w-28 rounded-lg border bg-white px-3 py-2 text-base text-slate-900" aria-invalid={parseTime(startText) === undefined} aria-label="Clip start time (mm:ss or hh:mm:ss)" /></label>
                    <label className="text-xs font-semibold text-slate-500">END<input value={endText} onChange={(e) => editTime("end", e.target.value)} onBlur={() => setEndText(formatTime(selectionEnd))} className="surface mt-1 block w-28 rounded-lg border bg-white px-3 py-2 text-base text-slate-900" aria-invalid={parseTime(endText) === undefined} aria-label="Clip end time (mm:ss or hh:mm:ss)" /></label>
                  </div>
                  <div className="flex items-center gap-3 text-sm"><span>{length.toFixed(1)}s / 60s</span><label className="flex items-center gap-2"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />Loop</label></div>
                </div>
              </section>

              <section className="surface rounded-2xl border bg-white p-5 shadow-soft">
                <h2 className="font-bold">Frame your clip</h2>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  {([["center", "Fill · center crop"], ["custom", "Fill · custom crop"], ["blur", "Fit · blurred background"]] as const).map(([value, label]) => (
                    <button key={value} onClick={() => setFraming(value)} aria-pressed={framing === value} className={`rounded-xl border p-3 text-left text-sm font-semibold ${framing === value ? "border-violet-500 bg-violet-50 text-violet-800" : "surface"}`}>{label}</button>
                  ))}
                </div>
                {framing === "custom" && <div className="mt-4"><p className="mb-2 text-sm text-slate-500">Drag to choose which part stays in frame.</p><div ref={cropRef} role="slider" aria-label="Horizontal crop position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(cropX * 100)} tabIndex={0} onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setCropX(Math.max(0, Math.min(1, cropX + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 0.05 : 0.01)))); } }} className="relative aspect-video touch-none overflow-hidden rounded-xl bg-slate-900" style={{ backgroundImage: `url("${video.thumbnail}")`, backgroundPosition: "center", backgroundSize: "cover" }} onPointerDown={dragCrop} onPointerMove={updateCrop} onPointerUp={() => { cropPointerRef.current = null; }}><div className="pointer-events-none absolute inset-y-0 w-1/3 border-2 border-violet-400 bg-violet-400/20" style={{ left: `${cropX * 66.67}%` }} /></div></div>}
              </section>
            </div>

            <aside className="space-y-5">
              <section className="surface rounded-2xl border bg-white p-5 shadow-soft">
                <h2 className="mb-4 font-bold">9:16 preview</h2>
                <div className="mx-auto aspect-[9/16] w-full max-w-[220px] overflow-hidden rounded-[2rem] border-[7px] border-slate-900 bg-black shadow-xl">
                  {framing === "blur" ? <div className="relative h-full" role="img" aria-label="Vertical clip preview with blurred background"><div className="absolute inset-0 scale-110 bg-cover bg-center blur-xl" style={{ backgroundImage: `url("${video.thumbnail}")` }} /><div className="relative h-full bg-contain bg-center bg-no-repeat" style={{ backgroundImage: `url("${video.thumbnail}")` }} /></div> : <div role="img" aria-label="Vertical clip preview" className="h-full w-full bg-cover" style={{ backgroundImage: `url("${video.thumbnail}")`, backgroundPosition: framing === "custom" ? `${cropX * 100}% center` : "center" }} />}
                </div>
                <p className="muted mt-4 text-center text-xs text-slate-500">Preview approximation. Final output is 1080 × 1920 MP4.</p>
              </section>
              <section className="surface rounded-2xl border bg-white p-5 shadow-soft">
                <h2 className="font-bold">Ready to create?</h2>
                {process.env.NEXT_PUBLIC_ALLOW_ONLY_CC_OR_OWN === "true" && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Only clip videos you own, have permission to use, or that are licensed for reuse.</p>}
                <label className="mt-4 flex items-start gap-3 text-sm leading-5"><input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-1" /><span>I own this video or have permission to use it, and I accept the <Link className="text-violet-700 underline" href="/terms">Terms</Link>.</span></label>
                {process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY && <div ref={turnstileRef} className="mt-4" />}
                <button onClick={createClip} disabled={!rights || busy || length < 1 || Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY && !turnstileToken)} className="mt-4 w-full rounded-xl bg-violet-600 px-5 py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Creating your clip..." : "Create clip"}</button>
                <p className="mt-3 text-center text-xs text-slate-500">Estimated render: ~{Math.max(10, Math.round(length * 0.6))} sec</p>
                {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
              </section>
              {job && <section className="surface rounded-2xl border bg-white p-5 shadow-soft" aria-live="polite">
                {                job.status === "error" ? <><h2 className="font-bold text-red-700">Clip couldn&apos;t be created</h2><p className="mt-2 text-sm">{job.error}</p><button className="mt-4 w-full rounded-lg border px-4 py-2" onClick={() => { localStorage.removeItem("clipshort-job"); localStorage.removeItem("clipshort-job-created"); setJob(null); }}>Try again</button></> :
                job.status === "ready" ? <><h2 className="font-bold">Your clip is ready!</h2><p className="mt-1 text-sm text-slate-500">MP4 · 1080 × 1920 · {length.toFixed(1)} sec · {formatBytes(job.fileSizeBytes)}</p><video controls playsInline src={`${API}/api/clips/${job.jobId}/download`} className="mt-4 max-h-80 w-full rounded-lg bg-black" /><a href={`${API}/api/clips/${job.jobId}/download`} download className="mt-4 block rounded-xl bg-violet-600 px-5 py-3 text-center font-bold text-white">Download MP4</a><button onClick={() => { localStorage.removeItem("clipshort-job"); localStorage.removeItem("clipshort-job-created"); setJob(null); setRights(false); updateSelection(0, Math.min(60, duration)); }} className="mt-3 w-full rounded-xl border px-5 py-3 font-semibold">Make another clip from the same video</button><p className="mt-3 text-center text-xs text-slate-500">Download link expires in 30 minutes.</p></> :
                    <><h2 className="font-bold">Creating your clip</h2><div className="mt-4 grid grid-cols-4 gap-1">{stageLabels.map((label, index) => <div key={label} className={`text-center text-xs ${index <= stageIndex ? "font-bold text-violet-700" : "text-slate-400"}`}>{label}</div>)}</div><div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-violet-600 transition-all" style={{ width: `${job.progress}%` }} /></div><p className="mt-2 text-right text-xs text-slate-500">{job.progress}%{job.queuePosition && job.queuePosition > 1 ? ` · Position ${job.queuePosition} in queue` : ""}</p></>}
              </section>}
            </aside>
          </div>
        )}
      </section>
      <footer className="border-t bg-white/70 py-6 text-center text-xs text-slate-500"><p>Use content responsibly and only when you have the right to do so.</p><div className="mt-2 flex justify-center gap-4"><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link><Link href="/dmca">DMCA / Takedown</Link></div></footer>
    </main>
  );
}
