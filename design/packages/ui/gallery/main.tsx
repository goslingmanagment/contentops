import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './gallery.css'
import { GalleryShell } from './gallery-shell'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Нет узла #root')
}

createRoot(rootElement).render(
  <StrictMode>
    <GalleryShell />
  </StrictMode>,
)
