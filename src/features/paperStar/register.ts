import {
  getPaperStarItem,
  getPaperStarStatus,
  setPaperStarStatus,
} from "../../modules/paperStar";
import { reportPluginError } from "../../platform/errorReporter";

const MENU_ID = "zotero-puls-paper-star-menuitem";
const STYLE_ID = "zotero-puls-paper-star-style";
const ROW_SELECTOR = ".row[id]";
const STARRED_ROW_CLASS = "zotero-puls-paper-starred";
const STAR_MARKER_CLASS = "zotero-puls-paper-star-marker";
const STARRED_ATTRIBUTE = "data-zotero-puls-paper-starred";

interface PaperStarRowState {
  observer?: MutationObserver;
  timer?: number;
  tree?: Element;
  style?: HTMLStyleElement;
}

interface PaperStarMenuState {
  popup: Element;
  onPopupShowing: EventListener;
}

interface PaperStarWindowState extends PaperStarRowState {
  menu?: PaperStarMenuState;
}

const states = new Map<Window, PaperStarWindowState>();

export function registerPaperStarFeature(win: _ZoteroTypes.MainWindow): void {
  if (states.has(win)) return;
  const state: PaperStarWindowState = {};
  states.set(win, state);
  installStyle(win, state);
  attachToItemTree(win, state);
  registerMenu(win, state);
}

export function unregisterPaperStarFeature(win: Window): void {
  const state = states.get(win);
  if (!state) return;
  if (state.timer) win.clearTimeout(state.timer);
  state.observer?.disconnect();
  state.menu?.popup.removeEventListener(
    "popupshowing",
    state.menu.onPopupShowing,
  );
  state.style?.remove();
  win.document
    .querySelectorAll(`.${STAR_MARKER_CLASS}`)
    .forEach((node: Element) => node.remove());
  win.document
    .querySelectorAll(`.${STARRED_ROW_CLASS}`)
    .forEach((node: Element) => node.classList.remove(STARRED_ROW_CLASS));
  win.document
    .querySelectorAll(`[${STARRED_ATTRIBUTE}]`)
    .forEach((node: Element) => node.removeAttribute(STARRED_ATTRIBUTE));
  win.document.getElementById(MENU_ID)?.remove();
  states.delete(win);
}

function installStyle(
  win: _ZoteroTypes.MainWindow,
  state: PaperStarWindowState,
): void {
  const style = win.document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#zotero-items-tree .row.${STARRED_ROW_CLASS} {
  position: relative;
}
#zotero-items-tree .${STAR_MARKER_CLASS} {
  position: absolute;
  inset-inline-end: 8px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 20px;
  color: #d97706;
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
}
`;
  const host = win.document.head || win.document.documentElement;
  if (!host) return;
  host.appendChild(style);
  state.style = style;
}

function attachToItemTree(
  win: _ZoteroTypes.MainWindow,
  state: PaperStarWindowState,
): void {
  const tree = win.document.getElementById("zotero-items-tree");
  const Observer = win.document.defaultView?.MutationObserver;
  if (!tree || !Observer) {
    state.timer = win.setTimeout(() => {
      state.timer = undefined;
      if (states.get(win) === state) attachToItemTree(win, state);
    }, 250);
    return;
  }
  state.tree = tree;
  const observer = new Observer(() => scheduleDecoration(win));
  state.observer = observer;
  observer.observe(tree, { childList: true, subtree: true });
  scheduleDecoration(win);
}

function scheduleDecoration(win: _ZoteroTypes.MainWindow): void {
  const state = states.get(win);
  if (!state || state.timer) return;
  state.timer = win.setTimeout(() => {
    state.timer = undefined;
    if (states.get(win) !== state) return;
    decorateRows(win, state.tree);
  }, 0);
}

function decorateRows(
  win: _ZoteroTypes.MainWindow,
  tree: Element | undefined,
): void {
  const view = win.ZoteroPane.itemsView;
  if (!tree || !view) return;
  for (const row of tree.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const match = row.id.match(/-row-(\d+)$/);
    if (!match) continue;
    const treeRow = view.getRow(Number(match[1])) as
      { ref?: Zotero.Item } | undefined;
    const item = treeRow?.ref;
    const target = item && getPaperStarItem(item);
    const starred = Boolean(target && getPaperStarStatus(target));
    row.classList.toggle(STARRED_ROW_CLASS, starred);
    if (starred) {
      row.setAttribute(STARRED_ATTRIBUTE, "true");
      ensureMarker(win.document, row);
    } else {
      row.removeAttribute(STARRED_ATTRIBUTE);
      row.querySelector(`.${STAR_MARKER_CLASS}`)?.remove();
    }
  }
}

function ensureMarker(doc: Document, row: HTMLElement): void {
  let marker = row.querySelector<HTMLElement>(`.${STAR_MARKER_CLASS}`);
  if (!marker) {
    marker = doc.createElement("span");
    marker.className = STAR_MARKER_CLASS;
    marker.textContent = "★";
    marker.title = "已标记论文星标";
    marker.setAttribute("aria-label", "已标记论文星标");
  }
  if (marker.parentElement !== row) row.appendChild(marker);
}

function registerMenu(
  win: _ZoteroTypes.MainWindow,
  state: PaperStarWindowState,
): void {
  const doc = win.document;
  if (doc.getElementById(MENU_ID)) return;
  const popup = doc.getElementById("zotero-itemmenu");
  if (!popup) return;
  const menu = doc.createXULElement("menuitem");
  menu.id = MENU_ID;
  const onPopupShowing = () => {
    const selected = win.ZoteroPane.getSelectedItems();
    const target =
      selected.length === 1 ? getPaperStarItem(selected[0]) : undefined;
    menu.setAttribute("hidden", String(!target));
    if (target) {
      menu.setAttribute(
        "label",
        getPaperStarStatus(target) ? "取消论文星标" : "标记为论文星标",
      );
    }
  };
  popup.addEventListener("popupshowing", onPopupShowing);
  state.menu = { popup, onPopupShowing };
  menu.addEventListener("command", () => void toggleFromMenu(win));
  popup.appendChild(menu);
}

async function toggleFromMenu(win: _ZoteroTypes.MainWindow): Promise<void> {
  const item = win.ZoteroPane.getSelectedItems()[0];
  const target = item && getPaperStarItem(item);
  if (!target) return;
  try {
    await setPaperStarStatus(target, !getPaperStarStatus(target));
    const view = win.ZoteroPane.itemsView;
    if (view) void view.refresh();
  } catch (error) {
    reportPluginError(error, {
      feature: "论文星标",
      operation: "右键菜单切换星标",
      userMessage: "更新论文星标失败。",
      window: win,
      metadata: { itemID: target.id },
    });
  }
}
