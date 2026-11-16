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

/**
 * What goes to Hub: the ticks the button counts — the shown drafts that may be approved — each with its own version, in
 * the feed's order. A tick hidden by another filter (or of a draft that left the approvable ones) stays and is not sent:
 * «Утвердить выбранные (N)» approves N posts the person sees, never one out of sight.
 */
export function pickedItems(
  picks: Picks,
  rows: readonly PickRow[],
): { id: number; version: number }[] {
  return rows.flatMap((row) => {
    const version = picks.get(row.id)
    return version === undefined ? [] : [{ id: row.id, version }]
  })
}
