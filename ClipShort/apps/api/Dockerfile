FROM node:22-alpine
RUN apk add --no-cache ffmpeg python3 py3-pip py3-virtualenv ca-certificates
RUN python3 -m venv /opt/yt-dlp && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade yt-dlp
ENV PATH="/opt/yt-dlp/bin:${PATH}"
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build --workspace @clipshort/shared && npm run build --workspace @clipshort/api
COPY apps/api/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /tmp/clipshort && chown -R node:node /app /opt/yt-dlp /tmp/clipshort
USER node
ENV NODE_ENV=production
EXPOSE 4000
ENTRYPOINT ["/entrypoint.sh"]
