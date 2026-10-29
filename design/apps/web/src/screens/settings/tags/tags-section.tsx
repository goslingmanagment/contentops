import { TAG_GROUP_LABEL, type Tag, TagGroupSchema } from '@contentops/contracts'
import { FilterChipsRow, FilterSelectChip } from '@contentops/ui/components/filter-chips'
import {
  SettingsSection,
  SettingsSectionSkeleton,
} from '@contentops/ui/components/settings-section'
import { EmptyState, ErrorLine } from '@contentops/ui/components/state-lines'
import { useMemo, useState } from 'react'
import { useTags } from '@/data/catalog'
import { SettingsPage } from '../settings-layout'
import { TagRow } from './tag-row'

const FREE = 'free'
const GROUP_OPTIONS = [
  ...TagGroupSchema.options.map((group) => ({ value: group, label: TAG_GROUP_LABEL[group] })),
  { value: FREE, label: 'без группы' },
]

function inGroup(tag: Tag, group: string | null): boolean {
  if (group === null) {
    return true
  }
  return group === FREE ? tag.group === null : tag.group === group
}

/** Сначала самые ходовые: строка не прыгает, когда меняют группу или русское имя. */
function byUses(left: Tag, right: Tag): number {
  return right.uses - left.uses || left.key.localeCompare(right.key)
}

/**
 * «Теги» (DESIGN §4.19): словарь — тег, русское имя, группа (действия / атрибуты /
 * настроение / без группы), «Слить с…» для дублей.
 */
export function TagsSection() {
  const tags = useTags()
  const [group, setGroup] = useState<string | null>(null)
  const rows = useMemo(
    () => (tags.data ? tags.data.filter((tag) => inGroup(tag, group)).sort(byUses) : null),
    [tags.data, group],
  )

  return (
    <SettingsPage title="Теги" refreshing={tags.isFetching && !tags.isPending}>
      <div className="flex flex-col gap-3">
        <FilterChipsRow canReset={group !== null} onReset={() => setGroup(null)}>
          <FilterSelectChip
            label="Группа"
            options={GROUP_OPTIONS}
            selected={group ? [group] : []}
            onSelectedChange={(values) => setGroup(values[0] ?? null)}
          />
        </FilterChipsRow>
        {tags.isError && !tags.data ? (
          <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void tags.refetch()} />
        ) : null}
        {tags.isPending ? <SettingsSectionSkeleton rows={8} /> : null}
        {rows && rows.length === 0 ? (
          <EmptyState action={{ label: 'Сбросить', onSelect: () => setGroup(null) }}>
            В этой группе тегов нет
          </EmptyState>
        ) : null}
        {rows && rows.length > 0 && tags.data ? (
          <SettingsSection>
            {rows.map((tag) => (
              <TagRow key={`${tag.key}:${tag.version}`} tag={tag} dictionary={tags.data} />
            ))}
          </SettingsSection>
        ) : null}
      </div>
    </SettingsPage>
  )
}
