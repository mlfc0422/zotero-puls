import {
  extractReadingStatus,
  mergeReadingStatus,
  type ReadingStatus,
} from "../features/readingStatus/core";

const pendingWrites = new Map<number, Promise<ReadingStatus>>();

export function getReadingStatus(item: Zotero.Item): ReadingStatus {
  const target = getReadingStatusItem(item);
  return extractReadingStatus(String(target?.getField("extra") || ""));
}

export async function setReadingStatus(
  item: Zotero.Item,
  read: boolean,
  totalPages?: number,
): Promise<ReadingStatus> {
  const target = getReadingStatusItem(item);
  if (!target) throw new Error("未找到可标记阅读状态的文献");
  const normalizedTotalPages =
    typeof totalPages === "number"
      ? Number.isInteger(totalPages)
        ? totalPages > 0
          ? totalPages
          : undefined
        : undefined
      : undefined;
  return updateReadingStatus(target, (current) =>
    read
      ? {
          ...current,
          read: true,
          readAt: new Date().toISOString(),
          ...(normalizedTotalPages
            ? {
                currentPage: normalizedTotalPages,
                totalPages: normalizedTotalPages,
              }
            : current.totalPages
              ? { currentPage: current.totalPages }
              : {}),
        }
      : { ...current, read: false, readAt: undefined },
  );
}

export async function setReadingProgress(
  item: Zotero.Item,
  currentPage: number,
  totalPages: number,
): Promise<ReadingStatus> {
  const target = getReadingStatusItem(item);
  if (!target) throw new Error("未找到可保存阅读进度的文献");
  const page = Math.floor(currentPage);
  const total = Math.floor(totalPages);
  if (!Number.isFinite(currentPage) || !Number.isFinite(totalPages))
    return getReadingStatus(target);
  if (page < 1 || total < 1) return getReadingStatus(target);
  const normalizedPage = Math.min(page, total);
  return updateReadingStatus(target, (current) => {
    const next: ReadingStatus = {
      ...current,
      currentPage: normalizedPage,
      totalPages: total,
    };
    if (normalizedPage >= total && !current.read) {
      next.read = true;
      next.readAt = new Date().toISOString();
    }
    return next;
  });
}

export async function addReadingSeconds(
  item: Zotero.Item,
  seconds: number,
): Promise<ReadingStatus> {
  const target = getReadingStatusItem(item);
  if (!target) throw new Error("未找到可累计阅读时长的文献");
  const increment = Math.max(0, Math.floor(seconds));
  if (!increment) return getReadingStatus(target);
  return updateReadingStatus(target, (current) => ({
    ...current,
    readingSeconds: (current.readingSeconds || 0) + increment,
  }));
}

function updateReadingStatus(
  target: Zotero.Item,
  update: (current: ReadingStatus) => ReadingStatus,
): Promise<ReadingStatus> {
  const previous =
    pendingWrites.get(target.id) || Promise.resolve(getReadingStatus(target));
  const write = previous
    .catch(() => getReadingStatus(target))
    .then(async () => {
      const current = getReadingStatus(target);
      const next = update(current);
      target.setField(
        "extra",
        mergeReadingStatus(String(target.getField("extra") || ""), next),
      );
      await target.saveTx();
      return next;
    });
  pendingWrites.set(target.id, write);
  void write.finally(() => {
    if (pendingWrites.get(target.id) === write) pendingWrites.delete(target.id);
  });
  return write;
}

export function getReadingStatusItem(
  item: Zotero.Item,
): Zotero.Item | undefined {
  if (item.isRegularItem()) return item;
  if (item.isAttachment()) {
    const parentID = item.parentItemID;
    return (parentID && Zotero.Items.get(parentID)) || item.parentItem || item;
  }
  return undefined;
}
