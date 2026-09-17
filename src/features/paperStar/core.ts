export interface PaperStarStatus {
  starred: boolean;
}

const BLOCK_START = "[Puls Star]";
const BLOCK_END = "[/Puls Star]";
const BLOCK_PATTERN = /\n?\[Puls Star\][\s\S]*?\[\/Puls Star\]\n?/gi;

export function extractPaperStarStatus(extra: string): PaperStarStatus {
  const block = extra.match(/\[Puls Star\]([\s\S]*?)\[\/Puls Star\]/i)?.[1];
  return {
    starred: Boolean(block && /^\s*status:\s*starred\s*$/im.test(block)),
  };
}

export function mergePaperStarStatus(extra: string, starred: boolean): string {
  const preserved = extra.replace(BLOCK_PATTERN, "").trim();
  if (!starred) return preserved;
  const block = [BLOCK_START, "status: starred", BLOCK_END].join("\n");
  return [preserved, block].filter(Boolean).join("\n\n");
}
