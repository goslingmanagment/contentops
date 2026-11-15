/**
 * «Утвердить выбранные»: a tick keeps the version of the post as it was on screen when it was ticked. A draft an agent
 * changes after the tick is sent with that older version, and Hub's own check refuses it («Пост изменили, пока вы
 * смотрели») — never approved unread. The feed re-reading in between changes nothing of the ticks.
 */
export type Picks = ReadonlyMap<number, number>

export interface PickRow {
  id: number
  version: number
}

export function togglePick(picks: Picks, row: PickRow): Picks {
  const next = new Map(picks)
  if (next.has(row.id)) next.delete(row.id)
  else next.set(row.id, row.version)
  return next
}

/** «Выбрать все»: each shown draft with the version on screen now (a tick already made keeps its own). */
export function pickAll(picks: Picks, rows: readonly PickRow[]): Picks {
  const next = new Map(picks)
  for (const row of rows) if (!next.has(row.id)) next.set(row.id, row.version)
  return next
}

/** What goes to Hub: every tick with its own version, in the feed's order, then any tick no longer shown. */
export function pickedItems(
  picks: Picks,
  rows: readonly PickRow[],
): { id: number; version: number }[] {
  const shown = rows.filter((row) => picks.has(row.id)).map((row) => row.id)
  const rest = [...picks.keys()].filter((id) => !shown.includes(id))
  return [...shown, ...rest].map((id) => ({ id, version: picks.get(id)! }))
}
