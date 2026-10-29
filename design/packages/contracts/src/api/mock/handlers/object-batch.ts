import type { ItemId } from '../../../domain/item-type'
import { summarizeMarkup } from '../../../domain/markup'
import type { ModelWorld, PlanRowRecord } from '../../../fixtures/world-types'
import { plural } from '../../../format'
import { objectBatchRoutes } from '../../routes/object-files'
import { rule } from '../domain-error'
import { type BoundRoute, bind } from '../handler'
import { markupOf } from '../views/item'
import { actorSays } from './actor-says'
import { catalogChanged, placementsChanged, touch } from './model-records'

/** Several objects of the Library at once (DESIGN §3.3): tags and «второй человек». */

function objectsWord(count: number): string {
  return `${count} ${plural(count, ['объекта', 'объектов', 'объектов'])}`
}

/** Rows on OnlyFans that the flag would cancel: not marked and not cancelled yet. */
function onlyFansRows(model: ModelWorld, items: ReadonlySet<ItemId>): PlanRowRecord[] {
  const onlyFans = new Set(
    model.model.accounts
      .filter((account) => account.platform === 'onlyfans')
      .map((account) => account.code),
  )
  return [...model.plan_rows.values()].filter(
    (row) =>
      row.item_id !== null &&
      items.has(row.item_id) &&
      onlyFans.has(row.account) &&
      !row.cancelled &&
      !row.mark,
  )
}

export function objectBatchHandlers(): BoundRoute[] {
  return [
    bind(objectBatchRoutes.tags, 'staff', (context) => {
      const model = context.model()
      const { items, add, remove } = context.body
      const removing = new Set(remove)
      const now = context.state.clock.now()
      const results = items.map((id) => {
        const record = model.items.get(id)
        if (record?.lifecycle.state !== 'active') {
          return { id, ok: false, code: 'not_found' }
        }
        const markup = markupOf(record)
        const field = markup.find((candidate) => candidate.field.key === 'tags')
        if (field?.field.key !== 'tags') return { id, ok: false, code: 'not_found' }
        const next = [...new Set([...field.field.value, ...add])].filter(
          (tag) => !removing.has(tag),
        )
        field.field = { key: 'tags', value: next }
        field.version += 1
        field.status = 'confirmed'
        field.confirmed_by = context.state.principal.name
        field.confirmed_at = now
        field.source_hint = null
        record.entry.tags = next
        record.entry.markup = summarizeMarkup(markup)
        touch(record)
        return { id, ok: true, code: null }
      })
      catalogChanged(model)
      const done = results.filter((result) => result.ok).length
      context.log({
        area: 'catalog',
        action: 'markup.tags_batch',
        phrase: `${actorSays(context.state, 'изменил')} теги у ${objectsWord(done)}`,
      })
      return { results }
    }),
    bind(objectBatchRoutes.secondPerson, 'staff', (context) => {
      const model = context.model()
      const { items, second_person: secondPerson, cancel_onlyfans_rows: consent } = context.body
      const active = new Set(
        items.filter((id) => model.items.get(id)?.lifecycle.state === 'active'),
      )
      const rows = secondPerson ? onlyFansRows(model, active) : []
      if (rows.length > 0 && !consent) {
        throw rule(
          'second_person_onlyfans',
          `Снимет ${rows.length} ${plural(rows.length, ['строку', 'строки', 'строк'])} на OnlyFans`,
          { rows: rows.length },
        )
      }
      const now = context.state.clock.now()
      for (const row of rows) {
        row.cancelled = { at: now, by: context.state.principal.id, reason: null }
      }
      const results = items.map((id) => {
        const record = model.items.get(id)
        if (!record || !active.has(id)) return { id, ok: false, code: 'not_found' }
        record.entry.second_person = secondPerson
        touch(record)
        return { id, ok: true, code: null }
      })
      catalogChanged(model)
      if (rows.length > 0) placementsChanged(model)
      context.log({
        area: 'catalog',
        action: 'item.flags_batch',
        phrase: secondPerson
          ? `${actorSays(context.state, 'отметил')} «второй человек в кадре» у ${objectsWord(active.size)}`
          : `${actorSays(context.state, 'снял')} «второй человек в кадре» у ${objectsWord(active.size)}`,
      })
      return { results }
    }),
  ]
}
