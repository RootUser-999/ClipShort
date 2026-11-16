# ClipShort

ClipShort creates a vertical MP4 (1080 × 1920) from a selected section of a YouTube video. It uses Next.js, TypeScript, Express, yt-dlp, FFmpeg, and BullMQ/Redis (with an in-memory queue for local development without Redis).

## Scaffold / project tree

```text
ClipShort/
├── apps/
│   ├── api/                 # Express API, queue workers, yt-dlp and FFmpeg
│   └── web/                 # Next.js App Router editor and legal pages
├── packages/
│   └── shared/              # URL, filename, selection validation and shared types
├── docker-compose.yml
├── .env.example
└── README.md
```

## Prerequisites

- Node.js 22.13+ and npm 10+ for local development.
- Docker Engine with Docker Compose v2 for the one-command container start.
- yt-dlp, FFmpeg (including ffprobe), and Redis are required for local clip rendering. Without Redis the API uses its in-memory queue.

## Start with Docker

```sh
cp .env.example .env
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The API health check is at [http://localhost:4000/api/health](http://localhost:4000/api/health). The Compose stack builds the web and API, starts Redis, installs FFmpeg/yt-dlp in the API image, and uses Redis-backed jobs. On Windows PowerShell, copy the example with `Copy-Item .env.example .env`.

To run locally without containers, install yt-dlp and FFmpeg and start Redis if desired, then run:

```sh
npm install
npm run dev
```

Copy `.env.example` to `.env` first. The web runs at port 3000 and the API at port 4000.

## Environment variables

| Variable | Default | Description |
|---|---:|---|
| `API_PORT` | `4000` | Express listening port |
| `WEB_ORIGIN` | `http://localhost:3000` | Allowed browser origin for CORS |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | API URL embedded in the web build |
| `REDIS_URL` | unset | Redis connection. Unset means local in-memory queue |
| `CLIP_STORAGE_DIR` | `/tmp/clipshort` | Temporary working and output files |
| `MAX_VIDEO_DURATION` | `43200` | Maximum source length in seconds (12 hours) |
| `MAX_JOB_DURATION_MS` | `300000` | Per-job wall-clock timeout (5 minutes) |
| `RENDER_CONCURRENCY` | `2` | Simultaneous renders per API process |
| `INFO_RATE_LIMIT` | `10` | Metadata requests per IP per minute |
| `CLIP_RATE_LIMIT` | `5` | Clip requests per IP per hour |
| `YTDLP_COOKIES_FILE` | unset | In-container path to an operator-provided YouTube cookies file |
| `HOST_YTDLP_COOKIES_FILE` | unset | Host path mounted read-only at `/run/secrets/youtube-cookies.txt` |
| `ALLOW_ONLY_CC_OR_OWN` | `false` | Displays a stronger rights warning in the editor |
| `TURNSTILE_ENABLED` | `false` | Require Cloudflare Turnstile verification on clip requests |
| `TURNSTILE_SECRET_KEY` | unset | Server-side Turnstile secret |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | unset | Turnstile site key for the browser (set to enable the widget) |

When enabling Turnstile, provide both site and secret keys, set `TURNSTILE_ENABLED=true`, and rebuild the web container. To use cookies with Compose, put an exported Netscape-format cookie file on the host, set `HOST_YTDLP_COOKIES_FILE` to its absolute path and `YTDLP_COOKIES_FILE=/run/secrets/youtube-cookies.txt`. Never commit cookies or request credentials from end users. Cookies are optional and should only be supplied by the service operator for videos they are authorized to access.

For the browser-visible settings, `NEXT_PUBLIC_*` values are build-time values. Rebuild the web image after changing them.

## Processing and reliability

- Submitted links are parsed against an explicit YouTube host allowlist and reduced to an 11-character video ID. The API builds the canonical YouTube URL itself.
- yt-dlp uses `--download-sections` around the requested range; FFmpeg then trims the clip and encodes H.264/AAC (when source audio exists), 1080 × 1920, yuv420p, and fast-start MP4.
- Jobs continue if the browser disconnects. The page retains the job ID in session storage and resumes its SSE status stream after a refresh.
- Generated clips and work files are deleted on a 10-minute cleanup sweep once older than 30 minutes. Clip download links expire at 30 minutes.
- Jobs are deduplicated briefly for identical requests, protected by per-IP rate limits, and use UUID job IDs. User-provided strings are never passed to a shell; child processes use argument arrays with `shell: false`.
- If YouTube blocks metadata or download access, the UI gives a user-facing error. The service does not bypass access restrictions. A cookies file is an optional operator-controlled configuration, not an end-user sign-in mechanism.

## Tests and checks

```sh
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

Unit tests cover YouTube URL variants, timestamp parsing, selection bounds, filename sanitization, and FFmpeg framing filters. The real-media integration test is opt-in because it requires network access plus installed yt-dlp/FFmpeg and downloads a short section of the Creative Commons Big Buck Bunny video:

```sh
CLIPSHORT_INTEGRATION=1 npm run test --workspace @clipshort/api
```

The test uses ffprobe to verify output dimensions, H.264/AAC codecs, and duration. An operator's network, YouTube availability, or bot checks can prevent that external integration test from running.

## Deployment

This backend needs subprocess execution, temporary disk, sustained SSE connections, and video encoding; **serverless platforms such as Vercel are not suitable for the backend**. Deploy to a VPS with at least 2 vCPU and 4 GB RAM (more for concurrent jobs), using Docker Compose or equivalent services for the API, web app, and Redis. Persist Redis data if queued jobs must survive restarts; clip media remains temporary.

Put Caddy or Nginx in front with HTTPS. Forward `/api/` to the API and other paths to Next.js. Configure the reverse proxy to:

- Allow request bodies large enough for API JSON while keeping a conservative limit (the API accepts only 20 KB JSON).
- Disable response buffering for `/api/clips/*/events` and use SSE-friendly read/idle timeouts (at least several minutes).
- Forward `X-Forwarded-For` correctly so per-IP limits are meaningful, and set `WEB_ORIGIN` to the public HTTPS origin.
- Restrict access to Redis and the API's internal ports; expose only the proxy in production.

## yt-dlp updates

The API container installs the current yt-dlp at image build and attempts an update at container startup and once per day. Rebuild the API image periodically. For a manually managed install, use `python -m pip install --upgrade yt-dlp`; avoid sharing cookies or update credentials.

## Troubleshooting

- **Video lookup says yt-dlp is missing:** local development requires yt-dlp and FFmpeg/ffprobe on `PATH`. The API returns a friendly error if the process cannot start. The Docker API image installs these tools.
- **YouTube asks to verify or says “not a bot”:** try another publicly available video. If appropriate, the service operator can configure an exported cookies file using the environment variables above. Never enter YouTube credentials into ClipShort.
- **A job stays queued:** check `/api/health` for the queue mode, ensure Redis is healthy when `REDIS_URL` is configured, and check API logs for worker errors.
- **An old download link fails:** generated media expires after 30 minutes. Create the clip again.
- **The browser reports a CORS error:** set `WEB_ORIGIN` to the exact public origin (scheme and host) of the web app, then restart the API.
- **SSE progress freezes behind a proxy:** disable proxy buffering for `/api/clips/*/events`, forward the response as `text/event-stream`, and increase idle/read timeouts as described in Deployment.
- **Clip creation reports low disk space:** free space in the configured temporary storage volume; the API requires at least 1 GB available before accepting a render.

## Legal notice

Only clip content you own, have permission to use, or are otherwise legally entitled to use. You are responsible for copyright, privacy, publicity, and platform compliance. ClipShort does not grant rights to source videos. See the in-app [Terms of Use](/terms), [Privacy Policy](/privacy), and [DMCA / Takedown](/dmca). Generated files are temporary and are not intended for permanent storage.

## Known limitations

- YouTube may restrict automated access, disable embedding, require verification, or change its delivery mechanisms; access is not guaranteed. Live and upcoming videos are blocked.
- The custom crop selector and phone preview are visual approximations based on the source thumbnail; the encoded crop is applied server-side.
- A clip job is kept in the job store for download until expiration. Redis is recommended for production; the in-memory mode loses job state if the API restarts.
- The optional Turnstile backend verification is implemented, but the web widget requires a public site key and is intended for deployments that configure it.
