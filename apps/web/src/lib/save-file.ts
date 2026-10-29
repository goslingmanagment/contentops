import type { FetchLike } from '@contentops/contracts'

/** Готовый файл с сервера: адрес и имя, под которым браузер его сохранит. */
export interface ServerFile {
  url: string
  fileName: string
  sizeBytes: number | null
}

/** Отдаёт файл браузеру обычной ссылкой со `download`: без загрузки в память вкладки. */
export function saveServerFile(file: Pick<ServerFile, 'url' | 'fileName'>): void {
  const anchor = document.createElement('a')
  anchor.href = file.url
  anchor.download = file.fileName
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
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
 * Прототип: сервер — заглушка в памяти, файлов у неё нет. По адресу выдачи она отвечает
 * текстовым образцом — что это за файл, вид копии, размер, источник, стёрты ли
 * метаданные, у архива список файлов. Браузер сохраняет его как `<имя по naming>.txt`;
 * имя в полоске и подсказках остаётся настоящим. С настоящим сервером это `saveServerFile`.
 */
export function prototypeFileSaver(fetchFile: FetchLike): (file: ServerFile) => void {
  return (file) => {
    fetchFile(file.url, { method: 'GET', headers: { Accept: 'text/plain' } })
      .then((response) => (response.ok ? response.text() : fallbackNote(file)))
      .catch(() => fallbackNote(file))
      .then((text) => saveText(text, `${file.fileName}.txt`))
  }
}
