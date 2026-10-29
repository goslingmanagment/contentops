import { TAG_GROUP_LABEL, type Tag, type TagGroup } from '../../../../domain/markup'
import { settingsRoutes } from '../../../routes/settings'
import { DomainError, notFound } from '../../domain-error'
import { type BoundRoute, bind } from '../../handler'
import type { MockState } from '../../state'
import { actorSays } from '../actor-says'
import { logSettingsChange } from './settings-log'
import { checkVersion } from './versions'

/** «Теги» (DESIGN §4.19): русское имя, группа свободному тегу, слияние дублей. */

function tagOf(state: MockState, key: string): Tag {
  const tag = state.world.tags.find((candidate) => candidate.key === key)
  if (!tag) throw notFound('Такого тега нет')
  return tag
}

function groupWord(group: TagGroup | null): string {
  return group ? TAG_GROUP_LABEL[group] : 'без группы'
}

const NEXT_GROUP: Record<TagGroup | 'none', TagGroup | null> = {
  action: 'attribute',
  attribute: 'mood',
  mood: null,
  none: 'action',
}

/** With `?demo=conflict` the other device moves the tag to the next group. */
function rivalGroup(tag: Tag): void {
  tag.group = NEXT_GROUP[tag.group ?? 'none']
}

/** Objects of every model get `into` instead of `from`; the indexes change their ETag. */
function retag(state: MockState, from: string, into: string): void {
  for (const model of state.world.models.values()) {
    let touched = false
    for (const record of model.items.values()) {
      if (!record.entry.tags.includes(from)) continue
      record.entry = {
        ...record.entry,
        tags: [...new Set(record.entry.tags.map((tag) => (tag === from ? into : tag)))],
      }
      touched = true
    }
    if (touched) model.catalog_version += 1
  }
}

function usesOf(state: MockState, key: string): number {
  let uses = 0
  for (const model of state.world.models.values()) {
    for (const record of model.items.values()) {
      if (record.entry.tags.includes(key)) uses += 1
    }
  }
  return uses
}

export function tagHandlers(): BoundRoute[] {
  return [
    bind(settingsRoutes.updateTag, 'owner', ({ state, params, body, if_match, log }) => {
      const tag = tagOf(state, params.tag)
      checkVersion(state, if_match, tag, {
        field: `тег «${tag.ru ?? tag.key}»`,
        rival: rivalGroup,
        valueOf: (record) => ({ ru: record.ru, group: record.group }),
      })
      const before = { ru: tag.ru, group: tag.group }
      if (body.ru !== undefined) tag.ru = body.ru
      if (body.group !== undefined) tag.group = body.group
      tag.version += 1
      logSettingsChange(log, state.principal.models, {
        action: 'tag.update',
        phrase: `${actorSays(state, 'изменил')} тег ${tag.key}`,
        changes: [
          { field: 'Русское имя', before: before.ru ?? 'нет', after: tag.ru ?? 'нет' },
          { field: 'Группа', before: groupWord(before.group), after: groupWord(tag.group) },
        ].filter((change) => change.before !== change.after),
      })
      return tag
    }),

    bind(settingsRoutes.mergeTag, 'owner', ({ state, params, body, log }) => {
      const source = tagOf(state, params.tag)
      const target = tagOf(state, body.into)
      if (source.key === target.key) {
        throw new DomainError('invalid_request', 'Тег сливается с другим тегом')
      }
      const before = target.uses
      retag(state, source.key, target.key)
      target.uses = usesOf(state, target.key)
      target.version += 1
      state.world.tags = state.world.tags.filter((tag) => tag.key !== source.key)
      logSettingsChange(log, state.principal.models, {
        action: 'tag.merge',
        phrase: `${actorSays(state, 'слил')} тег ${source.key} с «${target.ru ?? target.key}»`,
        changes: [{ field: 'Объектов', before: String(before), after: String(target.uses) }],
      })
      return target
    }),
  ]
}
