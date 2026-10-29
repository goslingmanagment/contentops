import { formatNumber } from '@contentops/contracts'

/** «$14,2». */
export function usdWords(value: number): string {
  return `$${formatNumber(Number(value.toFixed(2)))}`
}
