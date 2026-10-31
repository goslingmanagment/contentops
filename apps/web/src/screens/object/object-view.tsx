import type { ItemDetail } from '@contentops/contracts'
import { PanelMessage } from '@contentops/ui/components/panel-frame'
import { useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useEffectEvent, useMemo, useRef } from 'react'
import { useRole } from '@/data/session'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { FieldLayout } from '@/shell/field/field-layout'
import type { QueryErrorSource } from '@/shell/field/query-error-line'
import { useCurrentModel } from '@/shell/model/model-context'
import { FileSelectionContext, useFileSelectionState } from './files/file-selection'
import { ObjectFiles } from './files/object-files'
import { PendingOperationsProvider } from './files/pending-operations'
import { ObjectTop } from './header/object-top'
import {
  type ObjectPageApi,
  ObjectPageContext,
  type OpenFileOptions,
  type SearchChangeOptions,
} from './object-context'
import { ObjectPanel } from './panel/object-panel'
import { useObjectPanel } from './panel/use-object-panel'
import { type ObjectSearch, viewerKeyOf } from './search'
import { ObjectViewer } from './viewer/object-viewer'
import { viewerEntries } from './viewer/viewer-files'

interface ObjectViewProps {
  detail: ItemDetail
  search: ObjectSearch
  onSearchChange: (patch: Partial<ObjectSearch>, options?: SearchChangeOptions) => void
  /** Фоновое обновление: полоска 2 px под шапкой, ввод не сбрасывается. */
  refreshing: boolean
  /** Чтение объекта: данные есть, но обновить не вышло — строка над содержимым. */
  query: QueryErrorSource
}

const CLOSED_VIEWER: Partial<ObjectSearch> = {
  view: undefined,
  t: undefined,
  v: undefined,
  compare: undefined,
}

/**
 * Объект целиком (DESIGN §4.4): шапка 72, мета-строка, «где залито» по пяти страницам,
 * файлы по ролям сразу на первом экране и панель «Сведения / История» справа.
 */
export function ObjectView({ detail, search, onSearchChange, refreshing, query }: ObjectViewProps) {
  const model = useCurrentModel()
  const role = useRole()
  const router = useRouter()
  const panel = useObjectPanel()
  const selection = useFileSelectionState(detail.entry.id)
  // Просмотр, открытый со страницы, закрывается «Назад»: так браузер возвращает контекст.
  const viewerPushed = useRef(false)

  const openFile = useCallback(
    (key: string, options: OpenFileOptions = {}) => {
      viewerPushed.current = true
      onSearchChange({ view: key, t: options.seconds, v: options.version, compare: undefined })
    },
    [onSearchChange],
  )
  const closeViewer = useCallback(() => {
    if (viewerPushed.current) {
      viewerPushed.current = false
      router.history.back()
      return
    }
    onSearchChange(CLOSED_VIEWER, { replace: true })
  }, [onSearchChange, router])
  const showPanel = panel.show
  // Раскрытая страница «где залито» живёт в панели: адрес с `?page=` открывает её сам.
  const panelOpen = panel.open || search.page !== undefined
  const closePanel = useCallback(() => {
    panel.close()
    if (search.page !== undefined) {
      onSearchChange({ page: undefined }, { replace: true })
    }
  }, [onSearchChange, panel.close, search.page])
  const togglePanel = panelOpen ? closePanel : showPanel
  useKeyboardShortcut({ code: 'KeyI', enabled: viewerKeyOf(search) === undefined }, togglePanel)
  const openPage = useCallback(
    (account: string | undefined) => {
      onSearchChange({ page: account, tab: undefined }, { replace: true })
      if (account) {
        showPanel()
      }
    },
    [onSearchChange, showPanel],
  )

  const api = useMemo<ObjectPageApi>(
    () => ({
      detail,
      model,
      canAct: role === 'owner' || role === 'manager',
      search,
      setSearch: onSearchChange,
      openFile,
      closeViewer,
      openPage,
      panelOpen,
      showPanel,
    }),
    [
      detail,
      model,
      role,
      search,
      onSearchChange,
      openFile,
      closeViewer,
      openPage,
      panelOpen,
      showPanel,
    ],
  )

  // Файла из адреса `…/a/<ID>/<файл>` в объекте нет: серая строка на месте панели, а не
  // молча открытый объект (§3.10).
  const viewKey = viewerKeyOf(search)
  const missingFile =
    viewKey !== undefined && !viewerEntries(detail, search).some((entry) => entry.key === viewKey)
      ? viewKey
      : null

  useKeyboardShortcut(
    { code: 'Escape', enabled: selection.keys.size > 0 && viewerKeyOf(search) === undefined },
    selection.clear,
  )
  useSpaceToView(viewKey === undefined, () => {
    const first = viewerEntries(detail, search)[0]
    if (first) {
      openFile(first.key)
    }
  })

  return (
    <ObjectPageContext value={api}>
      <FileSelectionContext value={selection}>
        <PendingOperationsProvider>
          <FieldLayout
            aside={
              missingFile ? (
                <PanelMessage
                  label="Файл"
                  width={panel.width}
                  onClose={() => onSearchChange(CLOSED_VIEWER, { replace: true })}
                >
                  Файла {missingFile} в {detail.entry.id} нет
                </PanelMessage>
              ) : panelOpen ? (
                <ObjectPanel width={panel.width} onClose={closePanel} />
              ) : null
            }
          >
            <ObjectTop
              info={{ open: panelOpen, onToggle: togglePanel }}
              refreshing={refreshing}
              query={query}
            />
            <ObjectFiles />
          </FieldLayout>
          <ObjectViewer />
        </PendingOperationsProvider>
      </FileSelectionContext>
    </ObjectPageContext>
  )
}

/**
 * `Space` на странице объекта — просмотр с первого файла (DESIGN §4.4), даже если фокус
 * ещё ни на чём не стоит. Сетка файлов слушает `Space` сама и открывает файл под фокусом;
 * у кнопок, полей и вкладок `Space` остаётся их клавишей.
 */
function useSpaceToView(enabled: boolean, open: () => void) {
  const onSpace = useEffectEvent(open)
  useEffect(() => {
    if (!enabled) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== 'Space' ||
        event.defaultPrevented ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !idleTarget(event.target)
      ) {
        return
      }
      event.preventDefault()
      onSpace()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}

/** Фокус ни на чём, что само понимает `Space`: страница, поле, обёртка без роли. */
function idleTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return true
  }
  return (
    !target.isContentEditable &&
    target.closest(
      'a, button, input, textarea, select, summary, [role], [tabindex]:not([tabindex="-1"])',
    ) === null
  )
}
