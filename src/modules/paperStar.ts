import {
  extractPaperStarStatus,
  mergePaperStarStatus,
  type PaperStarStatus,
} from "../features/paperStar/core";

const pendingWrites = new Map<number, Promise<PaperStarStatus>>();

export function getPaperStarStatus(item: Zotero.Item): boolean {
  const target = getPaperStarItem(item);
  return Boolean(
    target &&
    extractPaperStarStatus(String(target.getField("extra") || "")).starred,
  );
}

export async function setPaperStarStatus(
  item: Zotero.Item,
  starred: boolean,
): Promise<PaperStarStatus> {
  const target = getPaperStarItem(item);
  if (!target) throw new Error("未找到可标记星标的文献");
  return updatePaperStarStatus(target, starred);
}

function updatePaperStarStatus(
  target: Zotero.Item,
  starred: boolean,
): Promise<PaperStarStatus> {
  const previous =
    pendingWrites.get(target.id) ||
    Promise.resolve({ starred: getPaperStarStatus(target) });
  const write = previous
    .catch(() => ({ starred: getPaperStarStatus(target) }))
    .then(async () => {
      const extra = String(target.getField("extra") || "");
      target.setField("extra", mergePaperStarStatus(extra, starred));
      await target.saveTx();
      return { starred };
    });
  pendingWrites.set(target.id, write);
  void write.then(
    () => {
      if (pendingWrites.get(target.id) === write)
        pendingWrites.delete(target.id);
    },
    () => {
      if (pendingWrites.get(target.id) === write)
        pendingWrites.delete(target.id);
    },
  );
  return write;
}

export function getPaperStarItem(item: Zotero.Item): Zotero.Item | undefined {
  if (item.isRegularItem()) return item;
  if (!item.isAttachment()) return undefined;
  const parentID = item.parentItemID;
  return (
    item.parentItem ||
    (typeof parentID === "number" ? Zotero.Items.get(parentID) : undefined) ||
    item
  );
}
