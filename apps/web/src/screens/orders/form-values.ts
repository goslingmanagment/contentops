/**
 * Значения полей формы: пустое поле уходит на сервер как «нет», а не пустой строкой.
 * `react-hook-form` зовёт преобразование и с исходным значением формы (`null`).
 */
export function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Число фото: пустое и отрицательное — ноль. */
export function countOrZero(value: unknown): number {
  const count = Number(value)
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
}

/** Обязательный текст: пробелы по краям не считаются, пустое остаётся пустым. */
export function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
