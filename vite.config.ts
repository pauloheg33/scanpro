import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "SCANPRO",
        short_name: "SCANPRO",
        description: "Leitura local de gabaritos existentes no navegador.",
        theme_color: "#10333a",
        background_color: "#f6efe6",
        display: "standalone",
        orientation: "portrait",
        start_url: "/scanpro/"
      }
    })
  ],
  base: "/scanpro/"
});

