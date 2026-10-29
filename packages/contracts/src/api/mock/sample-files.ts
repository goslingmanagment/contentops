import { formatBytes, formatNumber, plural } from '../../format'
import type { MockState } from './state'

/**
 * Prototype files. The mock issues download URLs but holds no media: behind each URL it
 * keeps a description of the file the product would hand out, and `GET <url>` answers it
 * as a short Russian text. The browser saves it as `<name>.txt`, so every «Скачать» ends
 * with a real file on disk, and the name in the toast stays the product name.
 */
export interface SampleFile {
  /** The product name by naming: `PPV-073_birthday_master__lora-2_2026-09-22_0300.mp4`. */
  file_name: string
  /** «Для заливки (копия для платформы)», «Архив дня», «ZIP передачи». */
  kind: string
  size_bytes: number | null
  /** «PPV-073 «День рождения» · Я.Диск: /Лора/PPV/…». */
  source: string
  meta_stripped: boolean
  /** Files inside an archive; empty for a single file. */
  members: readonly string[]
  /** A file of the archive shown by its first lines: `manifest.csv` of a promo handoff. */
  appendix?: { name: string; lines: readonly string[] }
}

const BASE = 'http://contentops.local'

/** Path and query as the mock server sees them: one key for issuing and for `GET`. */
export function sampleKey(url: string): string {
  const parsed = new URL(url, BASE)
  return `${parsed.pathname}${parsed.search}`
}

/** Remembers what lies behind a download URL; the same URL issued again is overwritten. */
export function registerSample(state: MockState, url: string, sample: SampleFile): void {
  state.samples.set(sampleKey(url), sample)
}

export function sampleAt(state: MockState, url: URL): SampleFile | null {
  return state.samples.get(`${url.pathname}${url.search}`) ?? null
}

const filesWord = (count: number) =>
  `${formatNumber(count)} ${plural(count, ['файл', 'файла', 'файлов'])}`

/** The text of the sample: what it is and which file the product would have given. */
export function sampleText(sample: SampleFile): string {
  const lines = [
    'Образец ContentOps.',
    'Это прототип: настоящих видео и фото в нём нет, поэтому вместо файла скачалась эта записка.',
    '',
    'Продукт выдал бы файл:',
    `  Имя: ${sample.file_name}`,
    `  Вид копии: ${sample.kind}`,
    `  Размер: ${sample.size_bytes === null ? 'неизвестен' : formatBytes(sample.size_bytes)}`,
    `  Источник: ${sample.source}`,
    `  Метаданные стёрты: ${sample.meta_stripped ? 'да' : 'нет'}`,
  ]
  if (sample.members.length > 0) {
    lines.push('', `В архиве ${filesWord(sample.members.length)}:`)
    lines.push(...sample.members.map((name, index) => `  ${index + 1}. ${name}`))
  }
  if (sample.appendix) {
    lines.push('', `${sample.appendix.name}, начало:`)
    lines.push(...sample.appendix.lines.map((line) => `  ${line}`))
  }
  return `${lines.join('\n')}\n`
}
