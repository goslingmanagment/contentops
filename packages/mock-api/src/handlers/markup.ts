import { markupRoutes } from '@contentops/contracts/api/routes/markup'
import { type BoundRoute, bind } from '../handler'
import { markupReview } from '../views/markup-review'
import { wholeList } from '../views/paginate'

/** «Разметка на проверку» (DESIGN §4.20): список целиком, как индекс. */
export function markupHandlers(): BoundRoute[] {
  return [bind(markupRoutes.review, 'read', ({ model }) => wholeList(markupReview(model())))]
}
