import {
  formatReadAt,
  formatReadAtShort,
  formatReadingDuration,
  formatReadingProgress,
  normalizeReaderProgress,
  type ReadingProgress,
  type ReadingStatus,
} from "./core";
import {
  addReadingSeconds,
  getReadingStatus,
  getReadingStatusItem,
  setReadingProgress,
  setReadingStatus,
} from "../../modules/readingStatus";
import { reportPluginError } from "../../platform/errorReporter";

const MENU_ID = "zotero-puls-reading-status-menuitem";
const READER_EVENT = "renderToolbar";
const READER_BUTTON_ATTRIBUTE = "data-zotero-puls-reading-item";
const READING_IDLE_MS = 90_000;
const READING_TICK_MS = 15_000;
const READING_FLUSH_SECONDS = 60;
const READING_PROGRESS_POLL_MS = 1_000;
const READING_PROGRESS_ROW_CLASS = "zotero-puls-reading-progress-row";
const READING_PROGRESS_MARKER_CLASS = "zotero-puls-reading-progress-marker";
const READING_PROGRESS_STYLE_ID = "zotero-puls-reading-progress-style";
let readerRegistered = false;
const readerDocumentListeners = new WeakSet<Document>();
const savingReadingItems = new Set<number>();
let readingTimer: ReturnType<typeof setInterval> | undefined;
const savingReadingProgress = new Set<number>();
let readingProgressTimer: ReturnType<typeof setInterval> | undefined;

interface ReadingRowState {
  observer?: MutationObserver;
  scheduled: boolean;
  timer?: number;
  style?: HTMLStyleElement;
}

interface ReadingMenuState {
  popup: Element;
  onPopupShowing: EventListener;
}

interface ReaderTimingSession {
  readerID: string;
  target: Zotero.Item;
  doc: Document;
  reader: _ZoteroTypes.ReaderInstance;
  lastActivityAt: number;
  focused: boolean;
}

interface ReadingDurationBuffer {
  target: Zotero.Item;
  lastTickAt: number;
  pendingSeconds: number;
}

const readingRowStates = new Map<Window, ReadingRowState>();
const readingMenuStates = new Map<Window, ReadingMenuState>();
const readerTimingSessions = new Map<string, ReaderTimingSession>();
const readingDurationBuffers = new Map<number, ReadingDurationBuffer>();
const lastReadingProgress = new Map<number, string>();

export function registerReadingStatusFeature(
  win: _ZoteroTypes.MainWindow,
): void {
  registerReadingStatusRows(win);
  registerReadingMenu(win);
}

export function registerReadingStatusReaderFeature(): void {
  if (readerRegistered) return;
  Zotero.Reader.registerEventListener(
    READER_EVENT,
    onReaderToolbar,
    addon.data.config.addonID,
  );
  readerRegistered = true;
}

export function unregisterReadingStatusFeature(win: Window): void {
  const rowState = readingRowStates.get(win);
  rowState?.observer?.disconnect();
  if (rowState?.timer) win.clearTimeout(rowState.timer);
  rowState?.style?.remove();
  clearReadingProgressDecorations(win.document);
  readingRowStates.delete(win);
  const menuState = readingMenuStates.get(win);
  menuState?.popup.removeEventListener(
    "popupshowing",
    menuState.onPopupShowing,
  );
  readingMenuStates.delete(win);
  win.document.getElementById(MENU_ID)?.remove();
}

export function shutdownReadingStatusFeature(): void {
  if (readerRegistered) {
    Zotero.Reader.unregisterEventListener(READER_EVENT, onReaderToolbar);
    readerRegistered = false;
  }
  for (const [win, state] of readingRowStates) {
    state.observer?.disconnect();
    state.style?.remove();
    clearReadingProgressDecorations(win.document);
  }
  readingRowStates.clear();
  for (const state of readingMenuStates.values()) {
    state.popup.removeEventListener("popupshowing", state.onPopupShowing);
  }
  readingMenuStates.clear();
  if (readingTimer) clearInterval(readingTimer);
  readingTimer = undefined;
  if (readingProgressTimer) clearInterval(readingProgressTimer);
  readingProgressTimer = undefined;
  for (const itemID of readingDurationBuffers.keys())
    void flushReadingDuration(itemID);
  readerTimingSessions.clear();
  readingDurationBuffers.clear();
  savingReadingItems.clear();
  savingReadingProgress.clear();
  lastReadingProgress.clear();
}

function onReaderToolbar(
  event: _ZoteroTypes.Reader.EventParams<typeof READER_EVENT>,
): void {
  const readerItem = event.reader.itemID
    ? Zotero.Items.get(event.reader.itemID)
    : undefined;
  if (!readerItem) return;
  const target = getReadingStatusItem(readerItem);
  if (!target) return;
  ensureReaderDocumentListeners(event.doc);
  registerReaderTimingSession(
    event.reader._instanceID,
    target,
    event.doc,
    event.reader,
  );
  const button = event.doc.createElement("button");
  button.type = "button";
  button.setAttribute(READER_BUTTON_ATTRIBUTE, String(target.id));
  button.style.cssText =
    "margin-inline-start:6px;border:1px solid var(--material-border,#d0d5dd);border-radius:6px;padding:4px 8px;background:var(--material-background,#fff);color:var(--fill-primary,#344054);font:inherit;font-size:12px;cursor:pointer;pointer-events:auto;position:relative;z-index:1";
  updateReaderButton(button, getReadingStatus(target));
  event.append(button);
  updateReaderButtons(event.doc, target.id);
}

function ensureReaderDocumentListeners(doc: Document): void {
  if (readerDocumentListeners.has(doc)) return;
  const activate = (event: Event) => {
    const eventTarget = event.target as Element | null;
    const button = eventTarget?.closest?.(
      `button[${READER_BUTTON_ATTRIBUTE}]`,
    ) as HTMLButtonElement | null;
    if (!button) return;
    if ((event as MouseEvent).button && (event as MouseEvent).button !== 0)
      return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const itemID = Number(button.getAttribute(READER_BUTTON_ATTRIBUTE));
    if (!Number.isInteger(itemID)) return;
    void toggleReaderStatus(doc, itemID);
  };
  const click: EventListener = (event) => activate(event);
  const keyDown: EventListener = (event) => {
    markReaderDocumentActive(doc);
    const key = (event as KeyboardEvent).key;
    if (key === "Enter" || key === " ") activate(event);
  };
  const activity: EventListener = () => markReaderDocumentActive(doc);
  const focus: EventListener = () => setReaderDocumentFocus(doc, true);
  const blur: EventListener = () => setReaderDocumentFocus(doc, false);
  const visibilityChange: EventListener = () =>
    setReaderDocumentFocus(doc, !doc.hidden);
  const pageHide: EventListener = () => void closeReaderDocument(doc);
  doc.addEventListener("click", click, true);
  doc.addEventListener("keydown", keyDown, true);
  doc.addEventListener("pointerdown", activity, true);
  doc.addEventListener("pointermove", activity, true);
  doc.addEventListener("wheel", activity, true);
  doc.addEventListener("focus", focus, true);
  doc.addEventListener("blur", blur, true);
  doc.addEventListener("visibilitychange", visibilityChange, true);
  doc.addEventListener("pagehide", pageHide, true);
  readerDocumentListeners.add(doc);
}

function registerReaderTimingSession(
  readerID: string,
  target: Zotero.Item,
  doc: Document,
  reader: _ZoteroTypes.ReaderInstance,
): void {
  const now = Date.now();
  readerTimingSessions.set(readerID, {
    readerID,
    target,
    doc,
    reader,
    lastActivityAt: now,
    focused: !doc.hidden,
  });
  const storedProgress = getReadingStatus(target);
  const progress = formatReadingProgress(
    storedProgress.currentPage,
    storedProgress.totalPages,
  );
  if (progress && !lastReadingProgress.has(target.id))
    lastReadingProgress.set(target.id, progress);
  if (!readingDurationBuffers.has(target.id)) {
    readingDurationBuffers.set(target.id, {
      target,
      lastTickAt: now,
      pendingSeconds: 0,
    });
  }
  if (!readingTimer)
    readingTimer = setInterval(tickReadingDurations, READING_TICK_MS);
  if (!readingProgressTimer)
    readingProgressTimer = setInterval(
      tickReadingProgress,
      READING_PROGRESS_POLL_MS,
    );
}

function markReaderDocumentActive(doc: Document): void {
  const now = Date.now();
  for (const session of readerTimingSessions.values()) {
    if (session.doc !== doc) continue;
    session.lastActivityAt = now;
    session.focused = !doc.hidden;
  }
}

function setReaderDocumentFocus(doc: Document, focused: boolean): void {
  for (const session of readerTimingSessions.values()) {
    if (session.doc === doc) session.focused = focused;
  }
}

function tickReadingDurations(): void {
  const now = Date.now();
  for (const buffer of readingDurationBuffers.values()) {
    const active = [...readerTimingSessions.values()].some(
      (session) =>
        session.target.id === buffer.target.id &&
        session.focused &&
        now - session.lastActivityAt <= READING_IDLE_MS,
    );
    const elapsedSeconds = Math.floor((now - buffer.lastTickAt) / 1000);
    buffer.lastTickAt = now;
    if (active && elapsedSeconds > 0) buffer.pendingSeconds += elapsedSeconds;
    if (buffer.pendingSeconds >= READING_FLUSH_SECONDS)
      void flushReadingDuration(buffer.target.id);
  }
}

function tickReadingProgress(): void {
  const now = Date.now();
  const activeReaders = new Map<
    number,
    {
      target: Zotero.Item;
      progress: ReadingProgress;
      lastActivityAt: number;
    }
  >();
  for (const session of readerTimingSessions.values()) {
    if (!session.focused || now - session.lastActivityAt > READING_IDLE_MS)
      continue;
    const progress = readReaderProgress(session.reader);
    if (!progress) continue;
    const previous = activeReaders.get(session.target.id);
    if (!previous || session.lastActivityAt > previous.lastActivityAt) {
      activeReaders.set(session.target.id, {
        target: session.target,
        progress,
        lastActivityAt: session.lastActivityAt,
      });
    }
  }
  for (const [itemID, active] of activeReaders) {
    const progress = formatReadingProgress(
      active.progress.currentPage,
      active.progress.totalPages,
    );
    if (
      !progress ||
      lastReadingProgress.get(itemID) === progress ||
      savingReadingProgress.has(itemID)
    )
      continue;
    savingReadingProgress.add(itemID);
    void persistReadingProgress(active.target, active.progress).then(
      () => savingReadingProgress.delete(itemID),
      () => savingReadingProgress.delete(itemID),
    );
  }
}

function readReaderProgress(
  reader: _ZoteroTypes.ReaderInstance,
): ReadingProgress | undefined {
  if (reader.type !== "pdf") return undefined;
  try {
    const stats =
      reader._internalReader?._state?.primaryViewStats ??
      reader._state?.primaryViewStats;
    const pageIndex = toFiniteNumber(
      stats?.pageIndex ?? reader.state?.pageIndex,
    );
    const totalPages = toFiniteNumber(stats?.pagesCount);
    return normalizeReaderProgress(pageIndex, totalPages);
  } catch {
    return undefined;
  }
}

function toFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function rememberReadingProgress(
  itemID: number,
  currentPage: number | undefined,
  totalPages: number | undefined,
): void {
  const progress = formatReadingProgress(currentPage, totalPages);
  if (progress) lastReadingProgress.set(itemID, progress);
}

function updateReaderButtonsForItem(itemID: number): void {
  for (const session of readerTimingSessions.values()) {
    if (session.target.id === itemID) updateReaderButtons(session.doc, itemID);
  }
}

function refreshReadingViews(): void {
  for (const win of Zotero.getMainWindows()) refreshItemsView(win);
}

function getCurrentReaderProgress(
  itemID: number,
  doc?: Document,
): ReadingProgress | undefined {
  let latestSession: ReaderTimingSession | undefined;
  for (const session of readerTimingSessions.values()) {
    if (session.target.id !== itemID || (doc && session.doc !== doc)) continue;
    if (!latestSession || session.lastActivityAt > latestSession.lastActivityAt)
      latestSession = session;
  }
  return latestSession ? readReaderProgress(latestSession.reader) : undefined;
}

async function persistReadingProgress(
  target: Zotero.Item,
  progress: ReadingProgress,
): Promise<void> {
  try {
    const status = await setReadingProgress(
      target,
      progress.currentPage,
      progress.totalPages,
    );
    const hasReaderSession = [...readerTimingSessions.values()].some(
      (session) => session.target.id === target.id,
    );
    if (hasReaderSession)
      rememberReadingProgress(target.id, status.currentPage, status.totalPages);
    updateReaderButtonsForItem(target.id);
    refreshReadingViews();
  } catch (error) {
    reportPluginError(error, {
      feature: "阅读状态",
      operation: "保存阅读进度",
      userMessage: "保存阅读进度失败。",
      notify: false,
      metadata: {
        itemID: target.id,
        currentPage: progress.currentPage,
        totalPages: progress.totalPages,
      },
    });
  }
}
async function closeReaderDocument(doc: Document): Promise<void> {
  tickReadingDurations();
  tickReadingProgress();
  const targetIDs = new Set<number>();
  for (const [readerID, session] of readerTimingSessions) {
    if (session.doc !== doc) continue;
    targetIDs.add(session.target.id);
    readerTimingSessions.delete(readerID);
  }
  for (const itemID of targetIDs) {
    await flushReadingDuration(itemID);
    const hasReaderSession = [...readerTimingSessions.values()].some(
      (session) => session.target.id === itemID,
    );
    if (!hasReaderSession) {
      readingDurationBuffers.delete(itemID);
      lastReadingProgress.delete(itemID);
    }
  }
  if (!readerTimingSessions.size && readingTimer) {
    clearInterval(readingTimer);
    readingTimer = undefined;
  }
  if (!readerTimingSessions.size && readingProgressTimer) {
    clearInterval(readingProgressTimer);
    readingProgressTimer = undefined;
  }
}

async function flushReadingDuration(itemID: number): Promise<void> {
  const buffer = readingDurationBuffers.get(itemID);
  if (!buffer || !buffer.pendingSeconds) return;
  const seconds = buffer.pendingSeconds;
  buffer.pendingSeconds = 0;
  try {
    await addReadingSeconds(buffer.target, seconds);
    for (const session of readerTimingSessions.values()) {
      if (session.target.id === itemID)
        updateReaderButtons(session.doc, itemID);
    }
  } catch (error) {
    buffer.pendingSeconds += seconds;
    reportPluginError(error, {
      feature: "阅读状态",
      operation: "保存阅读时长",
      userMessage: "保存阅读时长失败。",
      notify: false,
      metadata: { itemID, seconds },
    });
  }
}

async function toggleReaderStatus(
  doc: Document,
  itemID: number,
): Promise<void> {
  if (savingReadingItems.has(itemID)) return;
  const item = Zotero.Items.get(itemID);
  const target = item && getReadingStatusItem(item);
  if (!target) return;
  const nextRead = !getReadingStatus(target).read;
  const liveProgress = nextRead
    ? getCurrentReaderProgress(itemID, doc)
    : undefined;
  savingReadingItems.add(itemID);
  updateReaderButtons(doc, itemID, "saving");
  try {
    await setReadingStatus(target, nextRead, liveProgress?.totalPages);
    if (liveProgress)
      rememberReadingProgress(
        itemID,
        liveProgress.currentPage,
        liveProgress.totalPages,
      );
    refreshReadingViews();
    updateReaderButtonsForItem(itemID);
  } catch (error) {
    const reported = reportPluginError(error, {
      feature: "阅读状态",
      operation: "阅读器按钮切换状态",
      userMessage: "更新阅读状态失败。",
      notify: false,
      metadata: { itemID },
    });
    updateReaderButtons(doc, itemID, "error", reported.message);
  } finally {
    savingReadingItems.delete(itemID);
  }
}

function updateReaderButtons(
  doc: Document,
  itemID: number,
  state: "idle" | "saving" | "error" = "idle",
  errorMessage = "",
): void {
  const buttons = doc.querySelectorAll<HTMLButtonElement>(
    `button[${READER_BUTTON_ATTRIBUTE}="${itemID}"]`,
  );
  const item = Zotero.Items.get(itemID);
  const status = item ? getReadingStatus(item) : { read: false };
  for (const button of buttons) {
    button.disabled = state === "saving";
    if (state === "saving") {
      button.textContent = "正在保存…";
      button.title = "正在保存阅读状态";
    } else if (state === "error") {
      button.textContent = "保存失败";
      button.title = `保存阅读状态失败：${errorMessage}`;
    } else {
      updateReaderButton(button, status);
    }
  }
}

function updateReaderButton(
  button: HTMLButtonElement,
  status: ReadingStatus,
): void {
  button.disabled = false;
  const duration = formatReadingDuration(status.readingSeconds);
  const progress = formatReadingProgress(status.currentPage, status.totalPages);
  button.textContent = status.read
    ? `✓ ${formatReadAtShort(status.readAt)}${progress ? ` · ${progress}` : ""}${duration ? ` · ${duration}` : ""}`
    : `○ 标记已读${progress ? ` · ${progress}` : ""}${duration ? ` · ${duration}` : ""}`;
  button.title = [
    status.read
      ? `${formatReadAt(status.readAt)}；单击恢复未读`
      : "单击标记为已读",
    progress ? `阅读进度：${progress}` : "",
    duration ? `累计有效阅读时长：${duration}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  button.setAttribute("aria-pressed", String(status.read));
}

function registerReadingStatusRows(win: _ZoteroTypes.MainWindow): void {
  if (readingRowStates.has(win)) return;
  const tree = win.document.getElementById("zotero-items-tree");
  const Observer = win.document.defaultView?.MutationObserver;
  if (!tree || !Observer) return;
  const state: ReadingRowState = { scheduled: false };
  installReadingProgressStyle(win, state);
  const scheduleDecoration = () => {
    if (state.scheduled) return;
    state.scheduled = true;
    state.timer = win.setTimeout(() => {
      state.scheduled = false;
      state.timer = undefined;
      if (readingRowStates.get(win) !== state) return;
      decorateReadingStatusRows(win, tree);
    }, 0);
  };
  const observer = new Observer(scheduleDecoration);
  state.observer = observer;
  observer.observe(tree, { childList: true, subtree: true });
  readingRowStates.set(win, state);
  scheduleDecoration();
}

function installReadingProgressStyle(
  win: _ZoteroTypes.MainWindow,
  state: ReadingRowState,
): void {
  const style = win.document.createElement("style");
  style.id = READING_PROGRESS_STYLE_ID;
  style.textContent = `
#zotero-items-tree .row.${READING_PROGRESS_ROW_CLASS} {
  position: relative;
}
#zotero-items-tree .${READING_PROGRESS_MARKER_CLASS} {
  position: absolute;
  inset-inline-end: 36px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  width: 32px;
  color: var(--fill-secondary, #667085);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  pointer-events: none;
}
`;
  const host = win.document.head || win.document.documentElement;
  if (!host) return;
  host.appendChild(style);
  state.style = style;
}

function decorateReadingStatusRows(
  win: _ZoteroTypes.MainWindow,
  tree: Element,
): void {
  const view = win.ZoteroPane.itemsView;
  if (!view) return;
  for (const row of tree.querySelectorAll<HTMLElement>(".row[id]")) {
    const match = row.id.match(/-row-(\d+)$/);
    if (!match) continue;
    const treeRow = view.getRow(Number(match[1])) as
      { ref?: Zotero.Item } | undefined;
    const item = treeRow?.ref;
    const target = item && getReadingStatusItem(item);
    const status = target ? getReadingStatus(target) : undefined;
    const progress = status
      ? formatReadingProgress(status.currentPage, status.totalPages)
      : "";
    row.style.boxSizing = "border-box";
    row.style.borderInlineStart = target
      ? `3px solid ${status?.read ? "#20815d" : "#d0d5dd"}`
      : "3px solid transparent";
    row.classList.toggle(READING_PROGRESS_ROW_CLASS, Boolean(progress));
    if (progress) {
      ensureReadingProgressMarker(win.document, row, progress);
    } else {
      row.querySelector(`.${READING_PROGRESS_MARKER_CLASS}`)?.remove();
    }
  }
}

function ensureReadingProgressMarker(
  doc: Document,
  row: HTMLElement,
  progress: string,
): void {
  let marker = row.querySelector<HTMLElement>(
    `.${READING_PROGRESS_MARKER_CLASS}`,
  );
  if (!marker) {
    marker = doc.createElement("span");
    marker.className = READING_PROGRESS_MARKER_CLASS;
  }
  marker.textContent = progress;
  marker.title = `阅读进度：${progress}`;
  marker.setAttribute("aria-label", `阅读进度 ${progress}`);
  if (marker.parentElement !== row) row.appendChild(marker);
}

function clearReadingProgressDecorations(doc: Document): void {
  doc
    .querySelectorAll(`.${READING_PROGRESS_MARKER_CLASS}`)
    .forEach((node: Element) => node.remove());
  doc
    .querySelectorAll(`.${READING_PROGRESS_ROW_CLASS}`)
    .forEach((node: Element) =>
      node.classList.remove(READING_PROGRESS_ROW_CLASS),
    );
}

function refreshItemsView(win: _ZoteroTypes.MainWindow): void {
  const view = win.ZoteroPane.itemsView;
  if (view) void view.refresh();
}

function registerReadingMenu(win: _ZoteroTypes.MainWindow): void {
  const doc = win.document;
  if (doc.getElementById(MENU_ID)) return;
  const popup = doc.getElementById("zotero-itemmenu");
  if (!popup) return;
  const menu = doc.createXULElement("menuitem");
  menu.id = MENU_ID;
  const update = () => {
    const item = win.ZoteroPane.getSelectedItems()[0];
    const target = item && getReadingStatusItem(item);
    menu.setAttribute("hidden", String(!target));
    if (target)
      menu.setAttribute(
        "label",
        getReadingStatus(target).read ? "标记为未读" : "标记为已读",
      );
  };
  popup.addEventListener("popupshowing", update);
  readingMenuStates.set(win, { popup, onPopupShowing: update });
  menu.addEventListener("command", () => {
    const item = win.ZoteroPane.getSelectedItems()[0];
    const target = item && getReadingStatusItem(item);
    if (!target) return;
    const nextRead = !getReadingStatus(target).read;
    const liveProgress = nextRead
      ? getCurrentReaderProgress(target.id)
      : undefined;
    void setReadingStatus(target, nextRead, liveProgress?.totalPages)
      .then(() => {
        if (liveProgress)
          rememberReadingProgress(
            target.id,
            liveProgress.currentPage,
            liveProgress.totalPages,
          );
        updateReaderButtonsForItem(target.id);
        refreshItemsView(win);
      })
      .catch((error) => {
        reportPluginError(error, {
          feature: "阅读状态",
          operation: "右键菜单切换状态",
          userMessage: "更新阅读状态失败。",
          window: win,
          metadata: { itemID: target.id },
        });
      });
  });
  popup.appendChild(menu);
}
