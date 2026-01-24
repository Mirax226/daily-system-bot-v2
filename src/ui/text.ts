const DEFAULT_MAX = 3500;

export function safePlain(text: string): string {
  return text.replace(/\u0000/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function truncateTelegram(text: string, max = DEFAULT_MAX): string {
  const normalized = safePlain(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

export function ensureMaxMessage(text: string, max = DEFAULT_MAX): string {
  return truncateTelegram(text, max);
}

export function formatLines(lines: string[]): string {
  return safePlain(lines.join('\n'));
}
