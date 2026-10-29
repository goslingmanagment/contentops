/**
 * Общие классы меню: выпадающее (`DropdownMenu`) и правый клик (`ContextMenu`) выглядят
 * одинаково (DESIGN §3.6, §7.3–7.5): пункт 40, радиус 12, тень всплывающего.
 */
export const menuContentClass =
  'z-50 min-w-52 overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-base text-popover-foreground shadow-md duration-120 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-98 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-98'

export const menuItemClass =
  "group/menu-item relative flex min-h-10 cursor-default items-center gap-2.5 rounded-lg px-3 py-2 text-base outline-hidden select-none transition-colors duration-120 focus:bg-accent focus:text-accent-foreground data-inset:pl-9 data-disabled:pointer-events-none data-disabled:opacity-50 data-[variant=destructive]:text-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-ink-3 data-[variant=destructive]:[&_svg]:text-destructive"

export const menuIndicatorItemClass = `${menuItemClass} pr-9`

export const menuLabelClass = 'px-3 pt-2 pb-1 text-sm text-ink-3 data-inset:pl-9'

export const menuSeparatorClass = '-mx-1.5 my-1.5 h-px bg-border'

export const menuShortcutClass = 'ml-auto pl-4 text-sm text-ink-3'

export const menuIndicatorClass =
  'pointer-events-none absolute right-3 flex size-4 items-center justify-center text-primary'
