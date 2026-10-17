export interface RecentlySnapshotItem {
  listId: string;
  listName: string;
  name: string;
  label: string;
  specification: string;
  checkedOffAt: string | null;
}

export const recentlyItemKey = (item: RecentlySnapshotItem): string => JSON.stringify([
  item.listId,
  item.name,
  item.specification,
  item.checkedOffAt,
]);

export const diffRecentlySnapshot = (
  previous: readonly RecentlySnapshotItem[] | null,
  current: readonly RecentlySnapshotItem[],
): { baseline: boolean; added: RecentlySnapshotItem[] } => {
  if (previous === null) return { baseline: true, added: [] };
  const previousKeys = new Set(previous.map(recentlyItemKey));
  const addedKeys = new Set<string>();
  const added: RecentlySnapshotItem[] = [];
  for (const item of current) {
    const key = recentlyItemKey(item);
    if (previousKeys.has(key) || addedKeys.has(key)) continue;
    addedKeys.add(key);
    added.push(item);
  }
  return { baseline: false, added };
};
