import { Fragment, isValidElement, type ReactNode } from 'react'

/**
 * Разметка SVG из дерева JSX без React DOM: функциональные мотивы обложки вызываются как
 * функции, элементы — строками. Хуков в мотивах нет — обложка рисуется один раз на
 * зерно и дальше живёт картинкой (`CoverArt`).
 */

/** Атрибуты SVG, которые пишутся верблюдом; остальные camelCase React — через дефис. */
const CAMEL_ATTRIBUTES = new Set([
  'viewBox',
  'preserveAspectRatio',
  'gradientUnits',
  'gradientTransform',
  'patternUnits',
  'patternTransform',
  'clipPathUnits',
  'stdDeviation',
])

function attributeName(name: string): string {
  if (name === 'className') {
    return 'class'
  }
  if (CAMEL_ATTRIBUTES.has(name)) {
    return name
  }
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function escapeMarkup(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

type Props = Record<string, unknown> & { children?: ReactNode }

export function svgMarkup(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return escapeMarkup(String(node))
  }
  if (Array.isArray(node)) {
    return node.map(svgMarkup).join('')
  }
  if (!isValidElement<Props>(node)) {
    throw new Error('В обложке встретился узел, который нельзя записать строкой')
  }
  const { type, props } = node
  if (type === Fragment) {
    return svgMarkup(props.children)
  }
  if (typeof type === 'function') {
    return svgMarkup((type as (props: Props) => ReactNode)(props))
  }
  if (typeof type !== 'string') {
    throw new Error('В обложке встретился компонент, который нельзя записать строкой')
  }
  let attributes = ''
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || value === undefined || value === null || value === false) {
      continue
    }
    attributes += ` ${attributeName(name)}="${escapeMarkup(String(value))}"`
  }
  return `<${type}${attributes}>${svgMarkup(props.children)}</${type}>`
}
