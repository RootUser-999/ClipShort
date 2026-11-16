#!/bin/sh
set -eu

update_ytdlp() {
  if ! /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade yt-dlp; then
    echo "ClipShort: yt-dlp update failed; continuing with the installed version." >&2
  fi
}

update_ytdlp
(
  while true; do
    sleep 86400
    update_ytdlp
  done
) &

exec node apps/api/dist/server.js
