import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@contentops/ui/components/dropdown-menu'
import { cn } from '@contentops/ui/lib/utils'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import { useSession } from '@/data/session'
import { Logo } from './logo'

/**
 * Имя продукта над колонкой (план продуктов §2.1): у человека с другими продуктами оно открывает
 * их список — тот, что дал Hub (`auth/me`), не набранный здесь. Переход — один шаг через вход Hub,
 * без второго пароля. Один продукт (контент-менеджер) — просто имя, списка нет.
 */
export function ProductSwitcher({ compact = false }: { compact?: boolean }) {
  const products = useSession().data?.products ?? []
  if (products.length < 2) return <Logo compact={compact} />
  const main = products.filter((product) => !product.quiet)
  const quiet = products.filter((product) => product.quiet)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex h-16 items-center gap-1 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
          compact ? 'justify-center' : 'pr-2',
        )}
        aria-label="ContentOps: другие продукты"
      >
        <Logo compact={compact} />
        {compact ? null : <ChevronDownIcon className="size-4 text-muted-foreground" aria-hidden />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {main.map((product) => (
          <DropdownMenuItem key={product.id} asChild>
            <a href={product.href} aria-current={product.current ? 'page' : undefined}>
              <span className="flex-1">{product.label}</span>
              {product.current ? <CheckIcon className="size-4" aria-hidden /> : null}
            </a>
          </DropdownMenuItem>
        ))}
        {quiet.length > 0 ? <DropdownMenuSeparator /> : null}
        {quiet.map((product) => (
          <DropdownMenuItem key={product.id} asChild className="text-muted-foreground">
            <a href={product.href}>{product.label}</a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
