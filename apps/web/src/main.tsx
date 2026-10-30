import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createAppRouter } from './app/router'
import { loadDevMock } from './data/dev-mock'
import './app.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Нет узла #root')
}

await loadDevMock()
const router = createAppRouter()

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
