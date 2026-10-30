import type { AccountCode } from '@contentops/contracts/domain/common'
import type { NotUploadedPage } from '@contentops/contracts/domain/search'
import { NOT_UPLOADED_TYPES, notUploadedStatus } from '@contentops/contracts/not-uploaded'
import { accountOf, type FactsContext } from '../fixtures/facts'
import { activeEntries, pairKey, summariesByPair } from './catalog'
import { integrationLineOf } from './counters'

/** «Ещё не залито» of one page with the tab counters of all pages (DESIGN §4.3). */

export function notUploadedPage(context: FactsContext, code: AccountCode): NotUploadedPage {
  const account = accountOf(context.model, code)
  const summaries = summariesByPair(context)
  const entries = activeEntries(context.model).sort((left, right) =>
    right.arrived_on.localeCompare(left.arrived_on),
  )
  const statusOn = (accountCode: AccountCode, entry: (typeof entries)[number]) => {
    const target = accountOf(context.model, accountCode)
    return notUploadedStatus(entry, summaries.get(pairKey(entry.id, accountCode)), target.platform)
  }
  const tabs = context.model.model.accounts.map((candidate) => ({
    account: candidate.code,
    count: entries.filter(
      (entry) => entry.type !== 'fyp' && statusOn(candidate.code, entry) === 'not_uploaded',
    ).length,
  }))
  const groups = NOT_UPLOADED_TYPES.flatMap((type) => {
    const ids = entries
      .filter((entry) => entry.type === type && statusOn(code, entry) === 'not_uploaded')
      .map((entry) => entry.id)
    return ids.length > 0 ? [{ type, item_ids: ids, count: ids.length }] : []
  })
  const coverage = context.model.coverage.get(code)
  const note =
    account.platform === 'onlyfans'
      ? 'vault OnlyFans Hub не видит — здесь всё, что не отмечено залитым'
      : coverage && !coverage.vault_complete
        ? `vault ${account.label} Hub обошёл не полностью — часть может быть уже залита`
        : null
  const integration = context.world.integrations.find(
    (candidate) => candidate.kind === 'hub' && candidate.account === code,
  )
  return {
    account: code,
    tabs,
    groups,
    planned_hidden: entries.filter((entry) => statusOn(code, entry) === 'in_plan').length,
    coverage_note: note,
    integration:
      integration && integration.state !== 'working'
        ? integrationLineOf(context.world, integration, context.now)
        : null,
  }
}
