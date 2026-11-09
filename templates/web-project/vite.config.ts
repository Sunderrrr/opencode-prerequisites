import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: "es2022",
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
})
