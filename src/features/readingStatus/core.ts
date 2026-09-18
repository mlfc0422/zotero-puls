export interface ReadingStatus {
  read: boolean;
  readAt?: string;
  readingSeconds?: number;
  currentPage?: number;
  totalPages?: number;
}

export interface ReadingProgress {
  currentPage: number;
  totalPages: number;
}

const BLOCK_START = "[Puls Reading]";
const BLOCK_END = "[/Puls Reading]";
const BLOCK_PATTERN = /\n?\[Puls Reading\][\s\S]*?\[\/Puls Reading\]\n?/g;

export function extractReadingStatus(extra: string): ReadingStatus {
  const block = extra.match(
    /\[Puls Reading\]([\s\S]*?)\[\/Puls Reading\]/,
  )?.[1];
  if (!block) return { read: false, readingSeconds: 0 };
  const read = /^\s*status:\s*read\s*$/m.test(block);
  const readAt = /^\s*readAt:\s*(.+?)\s*$/m.exec(block)?.[1]?.trim();
  const readingSeconds = Math.max(
    0,
    Number(/^\s*readingSeconds:\s*(\d+)\s*$/m.exec(block)?.[1] || 0),
  );
  const currentPage = parsePositiveInteger(
    /^\s*currentPage:\s*(\d+)\s*$/m.exec(block)?.[1],
  );
  const totalPages = parsePositiveInteger(
    /^\s*totalPages:\s*(\d+)\s*$/m.exec(block)?.[1],
  );
  const status: ReadingStatus = { read, readingSeconds };
  if (readAt) status.readAt = readAt;
  if (currentPage) status.currentPage = currentPage;
  if (totalPages) status.totalPages = totalPages;
  return status;
}

export function mergeReadingStatus(
  extra: string,
  status: ReadingStatus,
): string {
  const preserved = extra.replace(BLOCK_PATTERN, "").trim();
  const currentPage = normalizePositiveInteger(status.currentPage);
  const totalPages = normalizePositiveInteger(status.totalPages);
  if (!status.read && !status.readingSeconds && !currentPage && !totalPages)
    return preserved;
  const lines = [BLOCK_START];
  if (status.read) lines.push("status: read");
  if (status.read && status.readAt) lines.push(`readAt: ${status.readAt}`);
  if (status.readingSeconds)
    lines.push(`readingSeconds: ${Math.floor(status.readingSeconds)}`);
  if (currentPage) lines.push(`currentPage: ${currentPage}`);
  if (totalPages) lines.push(`totalPages: ${totalPages}`);
  lines.push(BLOCK_END);
  return [preserved, lines.join("\n")].filter(Boolean).join("\n\n");
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  return normalizePositiveInteger(value ? Number(value) : undefined);
}

function normalizePositiveInteger(
  value: number | undefined,
): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const integer = Math.floor(value as number);
  return integer > 0 ? integer : undefined;
}

export function formatReadingProgress(
  currentPage: number | undefined,
  totalPages: number | undefined,
): string {
  const current = normalizePositiveInteger(currentPage);
  const total = normalizePositiveInteger(totalPages);
  if (!current || !total || current > total) return "";
  return `${current}/${total}`;
}

export function normalizeReaderProgress(
  pageIndex: number | undefined,
  totalPages: number | undefined,
): ReadingProgress | undefined {
  const currentPage = normalizePositiveInteger(
    pageIndex === undefined ? undefined : Math.floor(pageIndex) + 1,
  );
  const total = normalizePositiveInteger(totalPages);
  if (!currentPage || !total) return undefined;
  return { currentPage: Math.min(currentPage, total), totalPages: total };
}

export function formatReadAt(value: string | undefined): string {
  if (!value) return "已读";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "已读";
  return `已读 · ${date.toLocaleString("zh-CN", { hour12: false })}`;
}

export function formatReadAtShort(value: string | undefined): string {
  if (!value) return "已读";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "已读";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `已读 · ${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function formatReadingDuration(seconds: number | undefined): string {
  const totalMinutes = Math.floor(Math.max(0, seconds || 0) / 60);
  if (!totalMinutes) return "";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes} 分`;
  return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}
