import type {
  AccountCode,
  IsoWeek,
  ItemId,
  LocalDate,
  LocalTime,
  NormKind,
  SurfaceKind,
} from '@contentops/contracts'
import { createContext, useContext } from 'react'

/**
 * Что окно «В план» получает готовым (DESIGN §4.13, §4.3): «Ещё не залито» подставляет
 * страницу вкладки и куда; место нормы — страницу, день и тип; ящик недели — страницы
 * и неделю; ◆ «старый файл в альбоме» включает «Залить заново». Всё можно поменять в окне.
 */
export interface PlanDialogPreset {
  accounts?: readonly AccountCode[]
  surface?: SurfaceKind
  date?: LocalDate
  time?: LocalTime | null
  /** Тип места нормы: подсказки поиска «Не было на Fansly 2». */
  kind?: NormKind
  /** Сразу вкладка «Выпуск PPV». */
  tab?: 'row' | 'release'
  reupload?: boolean
  /** «Отметить выложенное вне плана…»: строка создаётся сразу отмеченной. */
  outside?: boolean
  /** Раскладка по неделе из ящика «Ещё не залито». */
  week?: IsoWeek
}

/**
 * Окно «В план» открывается из многих мест (полоса выделения, быстрый взгляд, объект,
 * экраны Плана), а живёт в папке Плана. Оболочка держит его одно на всё приложение.
 */
export interface PlanDialogApi {
  openPlanDialog(items: readonly ItemId[], preset?: PlanDialogPreset): void
}

export const PlanDialogContext = createContext<PlanDialogApi | null>(null)

export function usePlanDialog(): PlanDialogApi {
  const api = useContext(PlanDialogContext)
  if (!api) {
    throw new Error('PlanDialogContext не подключён: экран вне оболочки')
  }
  return api
}
