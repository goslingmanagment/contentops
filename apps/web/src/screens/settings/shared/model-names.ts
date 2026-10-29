import type { Model, ModelCode } from '@contentops/contracts'

/** «Лора, Lily» по кодам; неизвестный код остаётся кодом. */
export function modelNamesOf(codes: readonly ModelCode[], models: readonly Model[]): string {
  return codes.map((code) => models.find((model) => model.code === code)?.name ?? code).join(', ')
}
