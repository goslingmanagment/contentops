import { MarkupReviewItemSchema } from '../../domain/markup-review'
import { pageSchema } from '../../domain/pagination'
import { defineRoute } from '../route'

/** Разметка по всей модели: папка «Разметка на проверку» (появляется с работающим ИИ). */
export const markupRoutes = {
  review: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/markup/review',
    response: pageSchema(MarkupReviewItemSchema),
  }),
}
