import type { Clock, FetchLike } from '@contentops/contracts'
import {
  createMockFetch,
  createPrototypeClock,
  DemoModeSchema,
  PrototypeRoleSchema,
} from '@contentops/mock-api'
import { type ServerFile, saveServerFile } from '@/lib/save-file'

/**
 * Заглушка API прототипа — только для разработки: модуль подключается динамически
 * (`loadDevMock`), в сборке продукта его нет. `?demo=` и `?as=` — её переключатели;
 * неверное значение отбрасывается, роль по умолчанию — КМ.
 */
export interface MockSession {
  fetch: FetchLike
  /** «Сейчас» прототипа: 22.09.2026 14:20 МСК и дальше по настоящему времени. */
  clock: Clock
  saveFile: (file: ServerFile) => void
}

export function createMockSession(demo: string | null, role: string | null): MockSession {
  const clock = createPrototypeClock()
  const mockFetch = createMockFetch({
    demo: DemoModeSchema.nullable().catch(null).parse(demo),
    role: PrototypeRoleSchema.catch('km').parse(role ?? 'km'),
    clock,
  })
  return { fetch: mockFetch, clock, saveFile: prototypeFileSaver(mockFetch) }
}

function saveText(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  saveServerFile({ url, fileName })
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Записка на случай, если заглушка не знает адреса: путь «Скачать» всё равно доходит до файла. */
function fallbackNote(file: ServerFile): string {
  return [
    'Образец ContentOps.',
    'Это прототип: настоящих видео и фото в нём нет, поэтому вместо файла скачалась эта записка.',
    '',
    `Продукт выдал бы файл: ${file.fileName}`,
    '',
  ].join('\n')
}

/**
 * Файлов у заглушки нет. По адресу выдачи она отвечает текстовым образцом — что это за
 * файл, вид копии, размер, источник, стёрты ли метаданные, у архива список файлов. Браузер
 * сохраняет его как `<имя по naming>.txt`; имя в полоске и подсказках остаётся настоящим.
 * С настоящим сервером это `saveServerFile`.
 */
function prototypeFileSaver(fetchFile: FetchLike): (file: ServerFile) => void {
  return (file) => {
    fetchFile(file.url, { method: 'GET', headers: { Accept: 'text/plain' } })
      .then((response) => (response.ok ? response.text() : fallbackNote(file)))
      .catch(() => fallbackNote(file))
      .then((text) => saveText(text, `${file.fileName}.txt`))
  }
}
