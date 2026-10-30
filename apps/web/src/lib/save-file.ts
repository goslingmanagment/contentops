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
