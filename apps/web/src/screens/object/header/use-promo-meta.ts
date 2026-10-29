import { usePromoChannels, usePromoCollection } from '@/data/promo'
import { useObjectPage } from '../object-context'

/**
 * Промо-подборке в мета-строке нужны канал и подрядчик: «Подборка · Instagram · 60 видео ·
 * 2,65 ГБ · GaranTTeam» (DESIGN §4.5). У других типов — `null`, запросов нет.
 */
export function usePromoMeta(): { before: string[]; after: string[] } | null {
  const { detail, model } = useObjectPage()
  const isPromo = detail.entry.type === 'promo'
  const channels = usePromoChannels(model.code).data
  const collection = usePromoCollection(model.code, detail.entry.id, isPromo).data
  if (!isPromo) {
    return null
  }
  const channel = channels?.find((candidate) => candidate.id === detail.entry.channel)
  const contractor = collection?.handoffs.at(-1)?.contractor_name
  return { before: channel ? [channel.name] : [], after: contractor ? [contractor] : [] }
}
