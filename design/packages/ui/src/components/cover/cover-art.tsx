import { cn } from 'cn'
import { memo, type ReactElement, useCallback, useState, useSyncExternalStore } from 'react'
import { compositionsByFamily } from './compositions'
import { coverBitmapUrl, watchCoverBitmap } from './cover-bitmaps'
import type { CoverFamily } from './families'
import type { CoverPaint } from './motif-props'
import { aspectRatioValue, buildCoverScene, type CoverAspect } from './scene'
import { svgMarkup } from './svg-markup'

interface CoverOptions {
  seed: string
  family: CoverFamily
  aspect: CoverAspect
  frame: number
}

interface CoverArtProps extends Omit<CoverOptions, 'frame'> {
  frame?: number
  /** `screen` — просмотр во весь экран; остальное — `thumb`. */
  resolution?: 'thumb' | 'screen'
  className?: string
}

/** ID градиентов: у картинки свой документ SVG, поэтому они не сталкиваются. */
const IDS = {
  background: 'bg',
  light: 'light',
  glow: 'glow',
  sheen: 'sheen',
  vignette: 'vignette',
} as const

/**
 * Синтетическая обложка SVG (DESIGN §7.9): градиент семейства, пятно света, мотивы
 * интерьера и виньетка. Людей и тел нет. Одно зерно — всегда одна картинка.
 */
function coverElement({ seed, family, aspect, frame }: CoverOptions): ReactElement {
  const compositions = compositionsByFamily[family]
  const scene = buildCoverScene({
    seed,
    family,
    aspect,
    frame,
    compositionCount: compositions.length,
  })
  const motifs = compositions[scene.composition] ?? compositions[0]
  const paint: CoverPaint = { glow: `url(#${IDS.glow})`, sheen: `url(#${IDS.sheen})` }
  const { gradient, light } = scene
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={scene.viewBox}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={IDS.background}
          x1={gradient.x1}
          y1={gradient.y1}
          x2={gradient.x2}
          y2={gradient.y2}
        >
          <stop
            offset="0"
            stopColor={`color-mix(in oklab, var(--c-light), var(--c-glow) ${gradient.glowInLight}%)`}
          />
          <stop
            offset={gradient.middleOffset}
            stopColor={`color-mix(in oklab, color-mix(in oklab, var(--c-light), var(--c-dark) ${gradient.darkInMiddle}%), var(--c-alt) ${gradient.altInMiddle}%)`}
          />
          <stop
            offset="1"
            stopColor={`color-mix(in oklab, color-mix(in oklab, var(--c-dark), var(--c-deep) ${gradient.deepInEnd}%), var(--c-alt) ${gradient.altInEnd}%)`}
          />
        </linearGradient>
        <radialGradient id={IDS.light}>
          <stop offset="0" stopColor="var(--c-glow)" stopOpacity={0.9} />
          <stop offset="1" stopColor="var(--c-glow)" stopOpacity={0} />
        </radialGradient>
        <radialGradient id={IDS.glow}>
          <stop offset="0" stopColor="var(--c-glow)" stopOpacity={0.85} />
          <stop offset="0.35" stopColor="var(--c-glow)" stopOpacity={0.35} />
          <stop offset="1" stopColor="var(--c-glow)" stopOpacity={0} />
        </radialGradient>
        <linearGradient id={IDS.sheen} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--c-glow)" stopOpacity={0.7} />
          <stop offset="0.5" stopColor="var(--c-glow)" stopOpacity={0} />
          <stop offset="0.75" stopColor="var(--c-glow)" stopOpacity={0.25} />
          <stop offset="1" stopColor="var(--c-glow)" stopOpacity={0} />
        </linearGradient>
        <radialGradient id={IDS.vignette} cx="0.5" cy="0.45" r="0.75">
          <stop offset="0.55" stopColor="var(--c-deep)" stopOpacity={0} />
          <stop offset="1" stopColor="var(--c-deep)" stopOpacity={scene.vignette} />
        </radialGradient>
      </defs>
      <rect x={-10} y={-10} width={180} height={180} fill={`url(#${IDS.background})`} />
      <circle
        cx={light.cx}
        cy={light.cy}
        r={light.r}
        fill={`url(#${IDS.light})`}
        opacity={light.opacity}
      />
      {Object.entries(motifs).map(([layer, Motif], index) => (
        <Motif key={layer} seed={scene.motifSeeds[index] ?? index} paint={paint} />
      ))}
      <rect x={-10} y={-10} width={180} height={180} fill={`url(#${IDS.vignette})`} />
    </svg>
  )
}

const PALETTE_SLOTS = ['light', 'dark', 'deep', 'glow', 'ink', 'alt'] as const
type PaletteSlot = (typeof PALETTE_SLOTS)[number]

const palettes = new Map<CoverFamily, Record<PaletteSlot, string>>()

/**
 * Цвета семейства — токены `--cover-<семейство>-*` из globals.css: у картинки нет доступа
 * к переменным страницы, поэтому цвета подставляются в разметку.
 */
function paletteOf(family: CoverFamily): Record<PaletteSlot, string> {
  const cached = palettes.get(family)
  if (cached) {
    return cached
  }
  const styles = getComputedStyle(document.documentElement)
  const palette = Object.fromEntries(
    PALETTE_SLOTS.map((slot) => [
      slot,
      styles.getPropertyValue(`--cover-${family}-${slot}`).trim() || '#888',
    ]),
  ) as Record<PaletteSlot, string>
  palettes.set(family, palette)
  return palette
}

/** Разметка сцены с цветами семейства: у картинки нет доступа к переменным страницы. */
function coverMarkup(options: CoverOptions): string {
  const palette = paletteOf(options.family)
  return svgMarkup(coverElement(options)).replace(
    /var\(--c-(light|dark|deep|glow|ink|alt)\)/g,
    (_, slot: PaletteSlot) => palette[slot],
  )
}

/** Длинная сторона растра в точках CSS: плитки и мозаики — до 300, просмотр — во весь экран. */
const LONG_SIDE = { thumb: 300, screen: 1400 } as const
export type CoverResolution = keyof typeof LONG_SIDE

function bitmapSize(aspect: CoverAspect, resolution: CoverResolution) {
  const scale = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1)
  const long = Math.round(LONG_SIDE[resolution] * scale)
  const ratio = aspectRatioValue[aspect]
  return ratio < 1
    ? { width: Math.round(long * ratio), height: long }
    : { width: long, height: Math.round(long / ratio) }
}

/**
 * Обложка — растровая картинка, как будущая миниатюра с сервера: место держит родитель
 * (`aspect-ratio`, фон `--muted`), готовый растр встаёт на него; впервые нарисованный
 * проявляется за 120 мс, из кэша — сразу (§7.8).
 */
export const CoverArt = memo(function CoverArt({
  seed,
  family,
  aspect,
  frame = 0,
  resolution = 'thumb',
  className,
}: CoverArtProps) {
  const { width, height } = bitmapSize(aspect, resolution)
  const key = `${family}|${aspect}|${frame}|${width}x${height}|${seed}`
  const subscribe = useCallback(
    (listener: () => void) =>
      watchCoverBitmap(
        { key, width, height, markup: () => coverMarkup({ seed, family, aspect, frame }) },
        listener,
      ),
    [key, width, height, seed, family, aspect, frame],
  )
  const url = useSyncExternalStore(subscribe, () => coverBitmapUrl(key))
  const [fromCache] = useState(() => url !== null)
  if (!url) {
    return null
  }
  return (
    <img
      src={url}
      alt=""
      aria-hidden
      draggable={false}
      decoding="async"
      data-cover-family={family}
      className={cn(
        'pointer-events-none select-none object-cover',
        !fromCache && 'duration-120 animate-in fade-in-0',
        className,
      )}
    />
  )
})
