import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true, // fail loudly instead of silently moving to 5174+ (Vite prints "Port 5173 is already in use")
    proxy: { "/api": "http://127.0.0.1:8787", "/auth": "http://127.0.0.1:8787" },
  },
});
