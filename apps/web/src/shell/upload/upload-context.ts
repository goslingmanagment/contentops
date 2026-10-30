import type { ModelCode, UploadKind } from '@contentops/contracts'
import { createContext, useContext, useEffect } from 'react'
import type { UploadTarget } from './upload-target'

/** Окно «Загрузить» с заданной целью и видом: «Загрузить свой монтаж» у нового PPV. */
export interface OpenUploadOptions {
  target?: UploadTarget
  kind?: UploadKind
}

/** Загрузка и лоток доступны любому экрану (DESIGN §3.7). */
export interface UploadsApi {
  /** Открыть окно «Загрузить», можно сразу с файлами (перетаскивание). */
  openUploadDialog(files?: readonly File[], options?: OpenUploadOptions): void
  /** Показать долгую сборку (202) в лотке и следить за ней. */
  trackOperation(model: ModelCode, operationId: string, label: string): void
  /** Цель загрузки, которую выставил экран: выбранная строка плана, объект в панели. */
  setScreenTarget(target: UploadTarget | null): void
}

export const UploadsContext = createContext<UploadsApi | null>(null)

export function useUploads(): UploadsApi {
  const api = useContext(UploadsContext)
  if (!api) {
    throw new Error('UploadsContext не подключён: экран вне оболочки')
  }
  return api
}

/**
 * Экран сообщает, куда пойдёт загрузка, пока он открыт: окно «Загрузить» подставит цель
 * само. Объект из адреса `/<модель>/i/<ID>` подставляется и без этого. Оболочка
 * сравнивает цели по содержимому, поэтому объект цели можно создавать прямо в рендере.
 */
export function useUploadTarget(target: UploadTarget | null): void {
  const { setScreenTarget } = useUploads()
  useEffect(() => {
    setScreenTarget(target)
  }, [target, setScreenTarget])
  useEffect(() => () => setScreenTarget(null), [setScreenTarget])
}
