import {
  createRootRoute,
  createRoute,
  lazyRouteComponent,
  retainSearchParams,
} from '@tanstack/react-router'
import { inboxDoneSearchSchema, inboxSearchSchema } from '@/screens/inbox/search'
import { journalSearchSchema } from '@/screens/journal/search'
import {
  customsSearchSchema,
  libraryRootSearchSchema,
  librarySectionSearchSchema,
  notUploadedSearchSchema,
} from '@/screens/library/search'
import { loginSearchSchema } from '@/screens/login/search'
import { objectSearchSchema } from '@/screens/object/search'
import {
  planCheckSearchSchema,
  planDaySearchSchema,
  planWeekSearchSchema,
} from '@/screens/plan/search'
import { promoSearchSchema } from '@/screens/promo/search'
import { AppShell } from '@/shell/app-shell'
import { ModelNotFound, ModelScope } from '@/shell/model/model-scope'
import {
  EntryRedirect,
  ModelIndexRedirect,
  PlanTodayRedirect,
  SettingsIndexRedirect,
} from './redirects'
import { RootLayout } from './root-layout'
import { parseSegment } from './route-params'
import { RootSearchSchema } from './search-params'

/**
 * Реестр маршрутов — все адреса DESIGN §2.4 в одном месте. Первый сегмент — модель.
 * Экран подключается лениво из публичного входа своей папки `src/screens/<экран>/index.ts`,
 * параметры адреса проверяются схемами из той же папки (`search.ts`). Агент экрана
 * работает только в своей папке; этот файл меняется, лишь когда появляется новый адрес.
 */

const libraryScreens = () => import('@/screens/library')
const ordersScreens = () => import('@/screens/orders')
const promoScreens = () => import('@/screens/promo')
const inboxScreens = () => import('@/screens/inbox')
const planScreens = () => import('@/screens/plan')
const settingsScreens = () => import('@/screens/settings')

export const rootRoute = createRootRoute({
  validateSearch: RootSearchSchema,
  search: { middlewares: [retainSearchParams(['demo', 'as', 'skin'])] },
  component: RootLayout,
})

const entryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: EntryRedirect,
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  validateSearch: loginSearchSchema,
  component: lazyRouteComponent(() => import('@/screens/login'), 'LoginScreen'),
})

/** Оболочка: верхняя полоса, колонка и белое поле; экраны рисуются внутри поля. */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_shell',
  component: AppShell,
})

const settingsIndexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'settings',
  component: SettingsIndexRedirect,
})

const settingsTabRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'settings/$tab',
  params: {
    parse: ({ tab }) => ({ tab: parseSegment.settingsTab(tab) }),
    stringify: ({ tab }) => ({ tab }),
  },
  component: lazyRouteComponent(settingsScreens, 'SettingsScreen'),
})

/** `#/<модель>/…`: права на модель проверяются здесь, 403 и 404 — на месте поля. */
const modelRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '$model',
  params: {
    parse: ({ model }) => ({ model: parseSegment.model(model) }),
    stringify: ({ model }) => ({ model }),
  },
  component: ModelScope,
  notFoundComponent: ModelNotFound,
})

const modelIndexRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: '/',
  component: ModelIndexRedirect,
})

const libraryRootRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'library',
  validateSearch: libraryRootSearchSchema,
  component: lazyRouteComponent(libraryScreens, 'LibraryRootScreen'),
})

const librarySectionRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'library/$section',
  params: {
    parse: ({ section }) => ({ section: parseSegment.section(section) }),
    stringify: ({ section }) => ({ section }),
  },
  validateSearch: librarySectionSearchSchema,
  component: lazyRouteComponent(libraryScreens, 'LibrarySectionScreen'),
})

/** Кастомы — раздел Библиотеки; `?view=orders` и `?view=to-ppv` открывают заказы. */
const customsRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'library/customs',
  validateSearch: customsSearchSchema,
  component: lazyRouteComponent(() => import('./customs-route'), 'CustomsRoute'),
})

const orderRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'library/customs/orders/$order',
  params: {
    parse: ({ order }) => ({ order: parseSegment.recordId(order) }),
    stringify: ({ order }) => ({ order }),
  },
  component: lazyRouteComponent(ordersScreens, 'OrderScreen'),
})

const notUploadedRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'library/not-uploaded',
  validateSearch: notUploadedSearchSchema,
  component: lazyRouteComponent(libraryScreens, 'NotUploadedScreen'),
})

const markupRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'library/markup',
  component: lazyRouteComponent(libraryScreens, 'MarkupReviewScreen'),
})

const deletedRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'library/deleted',
  component: lazyRouteComponent(libraryScreens, 'DeletedItemsScreen'),
})

const promoRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'library/promo',
  validateSearch: promoSearchSchema,
  component: lazyRouteComponent(promoScreens, 'PromoRootScreen'),
})

const promoChannelRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'library/promo/$channel',
  params: {
    parse: ({ channel }) => ({ channel: parseSegment.recordId(channel) }),
    stringify: ({ channel }) => ({ channel }),
  },
  component: lazyRouteComponent(promoScreens, 'PromoChannelScreen'),
})

const promoCollectionRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'library/promo/$channel/$collection',
  params: {
    parse: ({ channel, collection }) => ({
      channel: parseSegment.recordId(channel),
      collection: parseSegment.itemId(collection),
    }),
    stringify: ({ channel, collection }) => ({ channel, collection }),
  },
  component: lazyRouteComponent(promoScreens, 'PromoCollectionScreen'),
})

const objectRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'i/$id',
  params: {
    parse: ({ id }) => ({ id: parseSegment.itemId(id) }),
    stringify: ({ id }) => ({ id }),
  },
  validateSearch: objectSearchSchema,
  component: lazyRouteComponent(() => import('@/screens/object'), 'ObjectScreen'),
})

const fileRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'a/$id/$file',
  params: {
    parse: ({ id, file }) => ({ id: parseSegment.itemId(id), file: parseSegment.recordId(file) }),
    stringify: ({ id, file }) => ({ id, file }),
  },
  component: lazyRouteComponent(() => import('@/screens/file'), 'FileScreen'),
})

/** Запрос поиска живёт в `history.state`, в адрес не попадает. */
const searchRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'search',
  component: lazyRouteComponent(() => import('@/screens/search'), 'SearchScreen'),
})

const inboxRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'inbox',
  validateSearch: inboxSearchSchema,
  component: lazyRouteComponent(inboxScreens, 'InboxScreen'),
})

const inboxGroupRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'inbox/g/$group',
  params: {
    parse: ({ group }) => ({ group: parseSegment.recordId(group) }),
    stringify: ({ group }) => ({ group }),
  },
  validateSearch: inboxSearchSchema,
  component: lazyRouteComponent(inboxScreens, 'InboxGroupScreen'),
})

const inboxDoneRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'inbox/done',
  validateSearch: inboxDoneSearchSchema,
  component: lazyRouteComponent(inboxScreens, 'InboxDoneScreen'),
})

const legacyReviewRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'inbox/old',
  component: lazyRouteComponent(inboxScreens, 'LegacyReviewScreen'),
})

const planIndexRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'plan',
  component: PlanTodayRedirect,
})

const planDayRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'plan/$date',
  params: {
    parse: ({ date }) => ({ date: parseSegment.date(date) }),
    stringify: ({ date }) => ({ date }),
  },
  validateSearch: planDaySearchSchema,
  component: lazyRouteComponent(planScreens, 'PlanDayScreen'),
})

const planWeekRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'plan/w/$week',
  params: {
    parse: ({ week }) => ({ week: parseSegment.week(week) }),
    stringify: ({ week }) => ({ week }),
  },
  validateSearch: planWeekSearchSchema,
  component: lazyRouteComponent(planScreens, 'PlanWeekScreen'),
})

const planCheckRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'plan/check',
  validateSearch: planCheckSearchSchema,
  component: lazyRouteComponent(planScreens, 'PlanCheckScreen'),
})

/**
 * Случай сверки — адрес выбора внутри «Сверить» (DESIGN §2.4): экран рисует родитель и
 * не пересоздаётся, когда выбор переходит к другому случаю.
 */
const planCaseRoute = createRoute({
  getParentRoute: () => planCheckRoute,
  path: '$case',
  params: {
    parse: (raw) => ({ case: parseSegment.recordId(raw.case) }),
    stringify: (params) => ({ case: params.case }),
  },
})

const journalRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'journal',
  validateSearch: journalSearchSchema,
  component: lazyRouteComponent(() => import('@/screens/journal'), 'JournalScreen'),
})

const modelPagesRoute = createRoute({
  getParentRoute: () => modelRoute,
  path: 'settings/pages/$account',
  params: {
    parse: ({ account }) => ({ account: parseSegment.account(account) }),
    stringify: ({ account }) => ({ account }),
  },
  component: lazyRouteComponent(settingsScreens, 'ModelPagesScreen'),
})

export const routeTree = rootRoute.addChildren([
  entryRoute,
  loginRoute,
  shellRoute.addChildren([
    settingsIndexRoute,
    settingsTabRoute,
    modelRoute.addChildren([
      modelIndexRoute,
      libraryRootRoute,
      librarySectionRoute,
      customsRoute,
      orderRoute,
      notUploadedRoute,
      markupRoute,
      deletedRoute,
      promoRoute,
      promoChannelRoute,
      promoCollectionRoute,
      objectRoute,
      fileRoute,
      searchRoute,
      inboxRoute,
      inboxGroupRoute,
      inboxDoneRoute,
      legacyReviewRoute,
      planIndexRoute,
      planDayRoute,
      planWeekRoute,
      planCheckRoute.addChildren([planCaseRoute]),
      journalRoute,
      modelPagesRoute,
    ]),
  ]),
])
