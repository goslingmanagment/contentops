import { UploadKindSchema } from '@contentops/contracts'
import { z } from 'zod'

/**
 * Поля окна «Загрузить». Файлы передаются кусками (протокол — вопрос к SPEC §6.1), а
 * последний шаг — команда `POST /uploads` из `packages/contracts` с видом и целью.
 */
export const UploadFormSchema = z.object({
  kind: UploadKindSchema,
  files: z.array(z.instanceof(File)).min(1, 'Выберите файлы'),
})
export type UploadForm = z.infer<typeof UploadFormSchema>
