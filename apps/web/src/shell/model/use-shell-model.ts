import type { Model } from '@contentops/contracts'
import { useParams } from '@tanstack/react-router'
import { useModels } from '@/data/session'
import { readLastSection } from '../last-section'

/**
 * Модель оболочки: из адреса, а на экранах без модели (настройки) и при чужой модели в
 * адресе — та, где человек был в последний раз, иначе первая доступная.
 */
export function useShellModel(): { model: Model | null; models: readonly Model[] } {
  const code = useParams({ strict: false, select: (params) => params.model })
  const models = useModels().data ?? []
  const fromAddress = models.find((model) => model.code === code)
  if (fromAddress) {
    return { model: fromAddress, models }
  }
  const lastCode = readLastSection()?.model
  const remembered = models.find((model) => model.code === lastCode)
  return { model: remembered ?? models[0] ?? null, models }
}
