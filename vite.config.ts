import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.MKTR_API_PROXY_TARGET || "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        configure(proxy) {
          proxy.on("proxyRes", (upstream, request, response) => {
            if (!/^\/api\/calls\/[^/?]+\/events(?:\?|$)/.test(request.url ?? "")) return;
            // http-proxy does not end an already-started response when the API
            // crashes. Forward that disconnect so EventSource can reconnect.
            upstream.once("close", () => { if (!upstream.complete) response.destroy(); });
          });
        }
      },
      "/media/clips": apiTarget
    }
  }
});
