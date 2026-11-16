import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(appDirectory, "..", "..", ".env") });

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@clipshort/shared"],
  async headers() {
    const apiOrigin = new URL(process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").origin;
    const scripts = process.env.NODE_ENV === "production"
      ? "'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com https://challenges.cloudflare.com"
      : "'self' 'unsafe-inline' 'unsafe-eval' https://www.youtube.com https://s.ytimg.com https://challenges.cloudflare.com";
    return [{
      source: "/:path*",
      headers: [{
        key: "Content-Security-Policy",
        value: [
          "default-src 'self'",
          "base-uri 'self'",
          "frame-ancestors 'self'",
          `script-src ${scripts}`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: https://i.ytimg.com https://*.ytimg.com",
          `connect-src 'self' ${apiOrigin} https://www.youtube.com https://challenges.cloudflare.com`,
          "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://challenges.cloudflare.com",
          `media-src 'self' blob: ${apiOrigin}`,
        ].join("; "),
      }],
    }];
  },
};

export default nextConfig;
