import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Сервер разработки отдаёт пути из `SERVER_ROUTES` настоящему серверу (`apps/server`). Имя,
 * которое открыл браузер, доходит до сервера как есть (`changeOrigin: false`), как за nginx:
 * «Войти через хаб» предлагается только на своём имени (SPEC §11.1).
 */
const server = {
  target: `http://127.0.0.1:${process.env.SERVER_PORT ?? 3000}`,
  changeOrigin: false,
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: { proxy: { '/api': server, '/auth/hub': server, '/healthz': server } },
})
