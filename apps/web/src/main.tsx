import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { moveOuterQueryIntoHash } from './app/outer-query'
import { createAppRouter } from './app/router'
import './app.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Нет узла #root')
}

moveOuterQueryIntoHash(window)
const router = createAppRouter()

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
