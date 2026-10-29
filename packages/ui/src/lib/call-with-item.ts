/** Вызывает обработчик с элементом по номеру, если такой элемент есть. */
export function callWithItem<Item>(
  items: readonly Item[],
  index: number,
  callback: (item: Item, index: number) => void,
): void {
  const item = items[index]
  if (item !== undefined) {
    callback(item, index)
  }
}
