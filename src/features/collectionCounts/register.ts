import { reportPluginError } from "../../platform/errorReporter";
import { countCollectionPapers, countReadPapers } from "./core";

const TREE_ID = "collection-tree";
const ROW_SELECTOR = '.row[role="treeitem"][id^="collection-tree-row-"]';
const COUNT_CLASS = "zotero-puls-collection-count";
const READ_SUMMARY_ID = "zotero-puls-reading-summary";
const READ_SUMMARY_CLASS = "zotero-puls-reading-summary";

interface CollectionCountState {
  observer?: MutationObserver;
  timer?: number;
  tree?: HTMLElement;
  onScroll?: () => void;
  summary?: HTMLElement;
  readCountRequest?: number;
  readCountDirty?: boolean;
  readCountPromise?: Promise<void>;
  readCountErrorReported?: boolean;
}

const states = new WeakMap<Window, CollectionCountState>();
let notifierID: string | undefined;

export function registerCollectionCountFeature(
  win: _ZoteroTypes.MainWindow,
): void {
  if (states.has(win)) return;
  const state: CollectionCountState = { readCountDirty: true };
  states.set(win, state);
  attachToCollectionTree(win, state);
}

export function registerCollectionCountNotifier(): void {
  if (notifierID) return;
  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: () => {
        for (const win of Zotero.getMainWindows()) {
          markReadCountDirty(win);
          scheduleRefresh(win);
        }
      },
    },
    ["collection", "collection-item", "item"],
    "zotero-puls-collection-counts",
  );
}

export function unregisterCollectionCountFeature(win: Window): void {
  const state = states.get(win);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.readCountRequest = (state.readCountRequest || 0) + 1;
  state.observer?.disconnect();
  if (state.tree && state.onScroll)
    state.tree.removeEventListener("scroll", state.onScroll, true);
  win.document
    .querySelectorAll(`.${COUNT_CLASS}`)
    .forEach((node: Element) => node.remove());
  win.document
    .querySelectorAll(`.${READ_SUMMARY_CLASS}`)
    .forEach((node: Element) => node.remove());
  states.delete(win);
}

export function shutdownCollectionCountFeature(): void {
  if (notifierID) {
    Zotero.Notifier.unregisterObserver(notifierID);
    notifierID = undefined;
  }
}

function attachToCollectionTree(
  win: _ZoteroTypes.MainWindow,
  state: CollectionCountState,
): void {
  const tree = win.document.getElementById(TREE_ID) as HTMLElement | null;
  if (!tree) {
    state.timer = win.setTimeout(() => attachToCollectionTree(win, state), 250);
    return;
  }
  state.tree = tree;
  state.readCountDirty = true;
  state.summary = ensureReadingSummary(win, tree);
  state.onScroll = () => scheduleRefresh(win);
  tree.addEventListener("scroll", state.onScroll, true);
  const observer = new win.MutationObserver(() => scheduleRefresh(win));
  state.observer = observer;
  observer.observe(tree, { childList: true, subtree: true });
  refreshCollectionCounts(win);
}

function scheduleRefresh(win: _ZoteroTypes.MainWindow): void {
  const state = states.get(win);
  if (!state || state.timer) return;
  state.timer = win.setTimeout(() => {
    state.timer = undefined;
    refreshCollectionCounts(win);
  }, 0);
}

function markReadCountDirty(win: Window): void {
  const state = states.get(win);
  if (state) state.readCountDirty = true;
}

function refreshCollectionCounts(win: _ZoteroTypes.MainWindow): void {
  const state = states.get(win);
  if (!state) return;
  const tree = win.document.getElementById(TREE_ID);
  if (!tree) return;
  const previousSummary = state.summary;
  state.summary = ensureReadingSummary(win, tree);
  if (state.summary && state.summary !== previousSummary)
    state.readCountDirty = true;
  if (state.summary && state.readCountDirty) {
    state.readCountDirty = false;
    if (!state.readCountPromise) {
      const refresh = refreshReadCount(win, state, state.summary);
      state.readCountPromise = refresh;
      void refresh.then(
        () => finishReadCountRefresh(win, state, refresh),
        () => finishReadCountRefresh(win, state, refresh),
      );
    }
  }

  const view = win.ZoteroPane.collectionsView;
  if (!view) return;

  const elements = Array.from(
    tree.querySelectorAll(ROW_SELECTOR),
  ) as HTMLElement[];
  for (const element of elements) {
    const index = getRowIndex(element.id);
    const row = index === undefined ? undefined : view.getRow(index);
    const cell = element.querySelector(
      ".cell.label.primary",
    ) as HTMLElement | null;
    const existing = element.querySelector(
      `.${COUNT_CLASS}`,
    ) as HTMLElement | null;
    if (!row?.isCollection() || !cell) {
      existing?.remove();
      continue;
    }

    const collection = row.ref as Zotero.Collection;
    const count = countCollectionPapers(collection.getChildItems(false, false));
    const label = String(count);
    let badge = existing as HTMLElement | null;
    if (!badge) {
      badge = win.document.createElement("span");
      badge.className = COUNT_CLASS;
      badge.style.cssText =
        "margin-inline-start:auto;padding-inline-start:8px;color:var(--fill-secondary,#98a2b3);font-size:0.9em;font-variant-numeric:tabular-nums;pointer-events:none";
      cell.appendChild(badge);
    }
    if (badge.textContent !== label) badge.textContent = label;
    badge.title = `直接包含 ${label} 篇论文`;
  }
}

function finishReadCountRefresh(
  win: _ZoteroTypes.MainWindow,
  state: CollectionCountState,
  refresh: Promise<void>,
): void {
  if (states.get(win) !== state || state.readCountPromise !== refresh) return;
  state.readCountPromise = undefined;
  if (state.readCountDirty) scheduleRefresh(win);
}

function ensureReadingSummary(
  win: _ZoteroTypes.MainWindow,
  tree: Element,
): HTMLElement | undefined {
  const existing = win.document.getElementById(READ_SUMMARY_ID);
  if (existing) return existing as HTMLElement;
  const parent = tree.parentElement;
  if (!parent) return undefined;

  const summary = win.document.createElement("div");
  summary.id = READ_SUMMARY_ID;
  summary.className = READ_SUMMARY_CLASS;
  summary.setAttribute("role", "status");
  summary.style.cssText =
    "display:flex;align-items:center;min-height:24px;padding:4px 10px;border-bottom:1px solid var(--color-border,#d0d5dd);color:var(--fill-secondary,#667085);font-size:0.9em;font-variant-numeric:tabular-nums;user-select:none;pointer-events:none";
  summary.textContent = "已读论文：读取中…";
  summary.title =
    "统计所有文献库中的唯一已读论文；同一论文属于多个分类时只计一次";
  parent.insertBefore(summary, tree);
  return summary;
}

async function refreshReadCount(
  win: _ZoteroTypes.MainWindow,
  state: CollectionCountState,
  summary: HTMLElement,
): Promise<void> {
  const request = (state.readCountRequest || 0) + 1;
  state.readCountRequest = request;
  summary.textContent = "已读论文：读取中…";
  try {
    const items = await getAllTopLevelItems();
    if (
      states.get(win) !== state ||
      state.readCountRequest !== request ||
      state.summary !== summary
    )
      return;
    const count = countReadPapers(items);
    summary.textContent = `已读论文：${count}`;
    summary.title =
      "统计所有文献库中的唯一已读论文；同一论文属于多个分类时只计一次";
    state.readCountErrorReported = false;
  } catch (error) {
    if (
      states.get(win) !== state ||
      state.readCountRequest !== request ||
      state.summary !== summary
    )
      return;
    summary.textContent = "已读论文：暂不可用";
    summary.title = "读取已读论文统计失败，请稍后重试";
    if (!state.readCountErrorReported) {
      state.readCountErrorReported = true;
      reportPluginError(error, {
        feature: "阅读状态",
        operation: "统计已读论文",
        userMessage: "读取已读论文统计失败。",
        window: win,
        notify: false,
      });
    }
  }
}

async function getAllTopLevelItems(): Promise<Zotero.Item[]> {
  const libraries = Zotero.Libraries.getAll().filter(
    (library) => library.libraryType !== "feed",
  );
  const items: Zotero.Item[] = [];
  for (const library of libraries) {
    const libraryItems = await Zotero.Items.getAll(
      library.libraryID,
      true,
      false,
    );
    items.push(...libraryItems);
  }
  return items;
}

function getRowIndex(id: string): number | undefined {
  const match = /^collection-tree-row-(\d+)$/.exec(id);
  return match ? Number(match[1]) : undefined;
}
