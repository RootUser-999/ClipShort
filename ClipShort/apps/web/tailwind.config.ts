import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111827",
        violet: { 500: "#7565f6", 600: "#624df0" },
      },
      boxShadow: {
        soft: "0 12px 40px rgba(27, 24, 55, .08)",
      },
    },
  },
  plugins: [],
};
export default config;
