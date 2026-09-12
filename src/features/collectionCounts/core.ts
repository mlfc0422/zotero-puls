import { extractReadingStatus } from "../readingStatus/core";

export interface CountableItem {
  isRegularItem(): boolean;
}

export interface ReadCountableItem extends CountableItem {
  id: number | string;
  deleted?: boolean;
  getField(field: string): unknown;
}

export interface CollectionItemSource {
  id: number | string;
  getChildItems(asIDs?: false, includeDeleted?: boolean): ReadCountableItem[];
  getChildCollections(
    asIDs?: false,
    includeTrashed?: boolean,
  ): CollectionItemSource[];
}

/** Collects unique items from a collection and, optionally, descendants. */
export function collectCollectionItems(
  collection: CollectionItemSource,
  includeDescendants: boolean,
): ReadCountableItem[] {
  const itemsByID = new Map<string, ReadCountableItem>();
  const visitedCollections = new Set<string>();

  const visit = (current: CollectionItemSource): void => {
    const collectionID = String(current.id);
    if (visitedCollections.has(collectionID)) return;
    visitedCollections.add(collectionID);

    for (const item of current.getChildItems(false, false)) {
      const itemID = String(item.id);
      if (itemID && !itemsByID.has(itemID)) itemsByID.set(itemID, item);
    }
    if (!includeDescendants) return;
    for (const child of current.getChildCollections(false, false)) visit(child);
  };

  visit(collection);
  return [...itemsByID.values()];
}

/** Counts only top-level bibliographic items shown as papers in a collection. */
export function countCollectionPapers(items: CountableItem[]): number {
  return items.reduce((count, item) => count + Number(item.isRegularItem()), 0);
}

/** Counts unique, non-deleted papers marked as read in the supplied items. */
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
