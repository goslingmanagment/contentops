import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { allowSyntheticCovers } from '../src/lib/synthetic-covers'
import './gallery.css'
import { GalleryShell } from './gallery-shell'

// Галерея показывает образцы без байтов — рисованными обложками.
allowSyntheticCovers()

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Нет узла #root')
}

createRoot(rootElement).render(
  <StrictMode>
    <GalleryShell />
  </StrictMode>,
)
