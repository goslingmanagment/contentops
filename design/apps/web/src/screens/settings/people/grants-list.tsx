import { formatDate, mskDate, type Person } from '@contentops/contracts'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { useToday } from '@/data/api-session'
import { usePersonGrants } from '@/data/settings'

/** Свёрнутая история выдачи прав: «10.09 · Дмитрий: добавил Lily». */
export function GrantsList({ person }: { person: Person }) {
  const today = useToday()
  const grants = usePersonGrants(person.id)
  if (grants.isError && !grants.data) {
    return <ErrorLine message="Не загрузилось" onRetry={() => void grants.refetch()} />
  }
  if (!grants.data) {
    return <Skeleton className="mb-4 h-4 w-80 rounded-sm" />
  }
  if (grants.data.length === 0) {
    return <p className="pb-4 text-muted-foreground text-sm">Прав не выдавали</p>
  }
  return (
    <ol aria-label={`История прав: ${person.name}`} className="flex flex-col gap-1 pb-4">
      {grants.data.map((grant) => (
        <li key={`${grant.at}-${grant.text}`} className="flex gap-3 text-sm">
          <span className="w-11 shrink-0 text-ink-3 tabular-nums">
            {formatDate(mskDate(grant.at), today)}
          </span>
          <span className="text-muted-foreground">
            {grant.by}: {grant.text}
          </span>
        </li>
      ))}
    </ol>
  )
}
