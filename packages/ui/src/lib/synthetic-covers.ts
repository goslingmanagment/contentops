let allowed = false

/**
 * Рисованные обложки (DESIGN §7.9) — только у заглушки разработки и в галерее: у них нет
 * байтов. В продукте их нет: без настоящей миниатюры место остаётся серым (§3.10), чтобы
 * решения не принимались по выдуманной картинке.
 */
export function allowSyntheticCovers(): void {
  allowed = true
}

export function syntheticCoversAllowed(): boolean {
  return allowed
}
