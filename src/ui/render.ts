import { ensureMaxMessage, formatLines } from './text';

export type RenderSection = { header?: string; body: string; footer?: string };

export function renderScreen(section: RenderSection): string {
  const lines: string[] = [];
  if (section.header) lines.push(section.header);
  if (section.body) lines.push(section.body);
  if (section.footer) lines.push(section.footer);
  return ensureMaxMessage(formatLines(lines));
}

export function kv(icon: string, key: string, value: string): string {
  return `${icon} ${key}: ${value}`.trim();
}

export function listItem(icon: string, text: string): string {
  return `• ${icon} ${text}`.trim();
}
