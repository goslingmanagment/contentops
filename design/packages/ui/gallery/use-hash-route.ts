import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

function readRoute(): string {
  return window.location.hash.replace(/^#/, '') || '/'
}

/** Текущий адрес галереи из `location.hash`. */
export function useHashRoute(): string {
  return useSyncExternalStore(subscribe, readRoute, () => '/')
}
