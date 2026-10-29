import type { AccountCode, ItemDetail, Model } from '@contentops/contracts'
import { createContext, useContext } from 'react'
import type { ObjectSearch } from './search'

export interface SearchChangeOptions {
  /** Заменить запись истории, а не добавить: смена вкладки, фильтра, закрытие просмотра. */
  replace?: boolean
}

export interface OpenFileOptions {
  seconds?: number
  /** Прежняя версия мастера: `v=1`. */
  version?: number
}

/**
 * Страница объекта для своих частей: карточка с сервера, права, адрес и просмотр. Части
 * страницы (шапка, файлы, панель) читают её отсюда, а не цепочкой свойств.
 */
export interface ObjectPageApi {
  detail: ItemDetail
  model: Model
  /** КМ и владелец; «только чтение» смотрит, но не меняет и не скачивает. */
  canAct: boolean
  search: ObjectSearch
  setSearch(patch: Partial<ObjectSearch>, options?: SearchChangeOptions): void
  /** Просмотр файла: `?view=<ключ>`, для мастера — с секунды и версии. */
  openFile(key: string, options?: OpenFileOptions): void
  closeViewer(): void
  /** Раскрыть в панели «Где залито · страница»; `undefined` — свернуть. */
  openPage(account: AccountCode | undefined): void
  /** Панель сведений открыта: раскрытие страницы и «Сведения» открывают её сами. */
  panelOpen: boolean
  showPanel(): void
}

export const ObjectPageContext = createContext<ObjectPageApi | null>(null)

export function useObjectPage(): ObjectPageApi {
  const api = useContext(ObjectPageContext)
  if (!api) {
    throw new Error('Часть страницы объекта вне ObjectPageContext')
  }
  return api
}
