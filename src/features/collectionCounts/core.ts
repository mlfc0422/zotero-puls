import { extractReadingStatus } from "../readingStatus/core";

export interface CountableItem {
  isRegularItem(): boolean;
}

export interface ReadCountableItem extends CountableItem {
  id: number | string;
  deleted?: boolean;
  getField(field: string): unknown;
}

/** Counts only top-level bibliographic items shown as papers in a collection. */
export function countCollectionPapers(items: CountableItem[]): number {
  return items.reduce((count, item) => count + Number(item.isRegularItem()), 0);
}

/** Counts unique, non-deleted papers marked as read across all libraries. */
export function countReadPapers(items: Iterable<ReadCountableItem>): number {
  const countedIDs = new Set<string>();
  let count = 0;
  for (const item of items) {
    if (item.deleted || !item.isRegularItem()) continue;
    const id = String(item.id);
    if (!id || countedIDs.has(id)) continue;
    const extra = String(item.getField("extra") || "");
    if (!extractReadingStatus(extra).read) continue;
    countedIDs.add(id);
    count += 1;
  }
  return count;
}
