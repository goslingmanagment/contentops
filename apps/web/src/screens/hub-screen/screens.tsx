import { getRouteApi } from '@tanstack/react-router'
import { HubScreen } from './hub-screen'

const publicationsApi = getRouteApi('/_shell/$model/publications')
const statsApi = getRouteApi('/_shell/$model/stats')

/** «Публикации»: лента, очередь площадки, карточка поста — экран Hub на всём поле. */
export function PublicationsScreen() {
  return <HubScreen screen="publications" search={publicationsApi.useSearch()} />
}

/** «Статистика»: какие медиа смотрят, покупают и комментируют — экран Hub на всём поле. */
export function StatsScreen() {
  return <HubScreen screen="stats" search={statsApi.useSearch()} />
}
