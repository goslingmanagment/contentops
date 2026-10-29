import { HotkeysHelp } from '@contentops/ui/components/hotkeys-help'
import { useState } from 'react'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { useShellModel } from '../model/use-shell-model'
import { TopSearch } from '../search/top-search'
import { AccountMenu } from './account-menu'

/**
 * Верхняя полоса на холсте над полем (DESIGN §2.1): поиск от левого края поля, справа
 * `?` со списком клавиш и аватар. Колокольчика нет: его заменяют счётчики в колонке.
 */
export function TopBar() {
  const { model } = useShellModel()
  const [hotkeysOpen, setHotkeysOpen] = useState(false)
  useKeyboardShortcut({ code: 'Slash', shift: true }, () => setHotkeysOpen((open) => !open))

  return (
    <header className="flex h-16 min-w-0 items-center justify-between gap-4 pr-3 pl-3">
      {model ? (
        // Своё состояние у поиска каждой модели: запрос Лоры не переезжает к Lily.
        <TopSearch key={model.code} model={model.code} />
      ) : (
        <div className="h-11 w-140 rounded-xl bg-background" />
      )}
      <div className="flex shrink-0 items-center gap-1">
        <HotkeysHelp open={hotkeysOpen} onOpenChange={setHotkeysOpen} />
        <AccountMenu />
      </div>
    </header>
  )
}
