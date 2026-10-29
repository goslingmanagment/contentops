import {
  type Account,
  type AccountCode,
  type FypVersion,
  UNIQ_LEVEL_LABEL,
  type UniqLevel,
  UniqLevelSchema,
} from '@contentops/contracts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'

export interface VersionPick {
  account: AccountCode
  no: number
  /** Такой версии ещё нет: соберётся долгой операцией после постановки. */
  fresh: boolean
}

/**
 * Уникальная версия фупа на каждую страницу (DESIGN §4.13): сначала версии, которых на
 * странице ещё не было и которые не взяла соседняя страница, потом новые номера.
 */
export function pickVersions(
  versions: readonly FypVersion[],
  accounts: readonly AccountCode[],
): VersionPick[] {
  const taken = new Set<number>()
  let nextNo = versions.reduce((max, version) => Math.max(max, version.no), 0) + 1
  return accounts.map((account) => {
    const free = versions.find(
      (version) =>
        !taken.has(version.no) && !version.placed.some((place) => place.account === account),
    )
    if (free) {
      taken.add(free.no)
      return { account, no: free.no, fresh: false }
    }
    const no = nextNo
    nextNo += 1
    return { account, no, fresh: true }
  })
}

interface FypVersionsLineProps {
  accounts: readonly Account[]
  picks: readonly VersionPick[]
  level: UniqLevel
  onLevelChange: (level: UniqLevel) => void
}

/** «Версии для Fansly 2, 3 · мягко ▾» и под ней номер версии на каждой странице. */
export function FypVersionsLine({ accounts, picks, level, onLevelChange }: FypVersionsLineProps) {
  const labelOf = (code: AccountCode) =>
    accounts.find((account) => account.code === code)?.label ?? code
  const pages = picks.map((pick) => labelOf(pick.account)).join(', ')
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-base">
        <span className="min-w-0 truncate">Версии для {pages}</span>
        <FypLevelSelect value={level} onChange={onLevelChange} />
      </div>
      <p className="text-ink-3 text-sm">
        {picks
          .map(
            (pick) =>
              `${labelOf(pick.account)} — версия ${pick.no}${pick.fresh ? ', соберётся' : ''}`,
          )
          .join(' · ')}
      </p>
    </div>
  )
}

interface FypLevelSelectProps {
  value: UniqLevel
  onChange: (level: UniqLevel) => void
}

/** Уровень версий фупа: «мягко ▾», «подрезка», «зеркало». */
export function FypLevelSelect({ value, onChange }: FypLevelSelectProps) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const parsed = UniqLevelSchema.safeParse(next)
        if (parsed.success) {
          onChange(parsed.data)
        }
      }}
    >
      <SelectTrigger size="sm" aria-label="Уровень версий" className="w-auto">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {UniqLevelSchema.options.map((option) => (
          <SelectItem key={option} value={option}>
            {UNIQ_LEVEL_LABEL[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
