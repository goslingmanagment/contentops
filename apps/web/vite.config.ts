import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** Сервер разработки отдаёт пути из `SERVER_ROUTES` настоящему серверу (`apps/server`). */
const server = `http://127.0.0.1:${process.env.SERVER_PORT ?? 3000}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: { proxy: { '/api': server, '/healthz': server } },
})
