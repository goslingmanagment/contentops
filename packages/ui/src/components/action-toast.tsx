import { cn } from 'cn'
import { type CSSProperties, useCallback, useEffect } from 'react'
import { Toaster, toast } from 'sonner'
import { hasModifierKey, isTypingTarget } from '../lib/platform'
import { measureToastPlace, TOAST_DEFAULT_PLACE } from '../lib/toast-place'
import { useLayoutWatch } from '../lib/use-layout-watch'
import { Button } from './button'
import { DarkSurface } from './dark-surface'
import { StatusSign } from './status-sign'

export interface ToastAction {
  label: string
  onSelect: () => void
}

export interface ActionToastOptions {
  /** «Поставлено · Fansly 2 · ср 23, 03:00». */
  message: string
  /** Ошибка — та же полоска с красным знаком, без путей и имён (§3.8). */
  tone?: 'default' | 'error'
  /** «Отменить», «Открыть», «Повторить», «Показать». */
  action?: ToastAction
  /**
   * Второе действие перед главным: «Принято → SET-075 · Открыть · Отобрать кадры» —
   * «Открыть» здесь, следующий шаг по типу — в `action` (§3.8).
   */
  secondaryAction?: ToastAction
  /** `Ctrl Z` выполняет действие полоски, пока она видна (только для отмены). */
  undoable?: boolean
  /** Причины одним нажатием: «не успели · заменили · пауза». */
  reasons?: readonly ToastAction[]
  /** Время показа; по умолчанию 6 с. */
  durationMs?: number
}

/**
 * Полоска одна: новая заменяет старую на месте (тот же id у sonner). Но закрытая полоска
 * ещё 200 мс уезжает, и всё, что пришло под её id в это время, уезжает вместе с ней —
 * так пропадал итог «Отменить» («Строка убрана»). Поэтому после закрытия следующая
 * полоска получает новый id.
 */
let current = { serial: 0, closed: false }

function currentId(): string {
  return `action-toast-${current.serial}`
}

function markClosed(id: string | number): void {
  if (id === currentId()) {
    current = { ...current, closed: true }
  }
}

const TOASTER_WIDTH = { '--width': 'min(40rem, calc(100vw - 2rem))' } as CSSProperties

/**
 * Полоска после действия (DESIGN §3.8): тёмная, 44, внизу по центру поля, одна на
 * экране — новая заменяет старую.
 */
export function showActionToast(options: ActionToastOptions): void {
  if (current.closed) {
    current = { serial: current.serial + 1, closed: false }
  }
  toast.custom((id) => <ActionToastBar toastId={id} {...options} />, {
    id: currentId(),
    duration: options.durationMs ?? 6000,
    onAutoClose: (closed) => markClosed(closed.id),
    onDismiss: (closed) => markClosed(closed.id),
  })
}

export function dismissActionToast(): void {
  closeToast(currentId())
}

function closeToast(id: string | number): void {
  markClosed(id)
  toast.dismiss(id)
}

interface ActionToasterProps {
  /** Поле, по центру которого стоит полоска (§3.8). */
  field?: string
  /** Что полоска не закрывает: лоток загрузок внизу справа (§3.7). */
  avoid?: string
}

/** Место для полосок; ставится один раз в оболочке приложения. */
export function ActionToaster({ field, avoid }: ActionToasterProps) {
  const measure = useCallback(
    () => (field && avoid ? measureToastPlace(field, avoid) : TOAST_DEFAULT_PLACE),
    [field, avoid],
  )
  const place = useLayoutWatch(measure, TOAST_DEFAULT_PLACE, Boolean(field && avoid))
  const style: CSSProperties =
    place.centerX === null ? TOASTER_WIDTH : { ...TOASTER_WIDTH, left: place.centerX }
  return (
    <Toaster
      position="bottom-center"
      visibleToasts={1}
      offset={{ bottom: place.bottom }}
      // Полоске с причинами-чипами нужно больше 356 px, заданных у sonner по умолчанию;
      // пустые края полосы не перехватывают нажатия.
      style={style}
      toastOptions={{ unstyled: true, className: 'pointer-events-none flex w-full justify-center' }}
    />
  )
}

interface ActionToastBarProps extends ActionToastOptions {
  toastId: string | number
}

export function ActionToastBar({
  toastId,
  message,
  tone = 'default',
  action,
  secondaryAction,
  undoable = false,
  reasons,
}: ActionToastBarProps) {
  useUndoHotkey(undoable ? action : undefined, toastId)
  // Сначала закрыть, потом действовать: итог действия придёт уже новой полоской.
  const run = (next: ToastAction) => {
    closeToast(toastId)
    next.onSelect()
  }
  return (
    <DarkSurface
      role={tone === 'error' ? 'alert' : 'status'}
      className="pointer-events-auto flex h-11 max-w-[min(40rem,calc(100vw-2rem))] items-center gap-3 rounded-xl bg-bar px-4 text-base shadow-md"
    >
      {tone === 'error' ? <StatusSign kind="trouble" /> : null}
      <span className="min-w-0 truncate">{message}</span>
      {reasons && reasons.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1">
          {reasons.map((reason) => (
            <button
              key={reason.label}
              type="button"
              onClick={() => run(reason)}
              className="h-7 rounded-3xl bg-secondary px-2.5 text-sm transition-colors duration-120 hover:bg-secondary-hover"
            >
              {reason.label}
            </button>
          ))}
        </span>
      ) : null}
      {secondaryAction ? (
        <Button
          variant="bar"
          size="sm"
          onClick={() => run(secondaryAction)}
          className={cn('shrink-0', action ? '-mr-3' : '-mr-2')}
        >
          {secondaryAction.label}
        </Button>
      ) : null}
      {action ? (
        <Button
          variant="bar"
          size="sm"
          onClick={() => run(action)}
          className={cn('-mr-2 shrink-0 font-semibold')}
        >
          {action.label}
        </Button>
      ) : null}
    </DarkSurface>
  )
}

/** `Ctrl Z` / `⌘ Z` отменяет последнее действие, пока видна полоска (§3.12). */
function useUndoHotkey(action: ToastAction | undefined, toastId: string | number) {
  useEffect(() => {
    if (!action) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyZ' || !hasModifierKey(event) || isTypingTarget(event.target)) {
        return
      }
      event.preventDefault()
      closeToast(toastId)
      action.onSelect()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [action, toastId])
}
