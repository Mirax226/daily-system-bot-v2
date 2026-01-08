import type { Context } from 'grammy';

import { config } from '../config';

export type ArchiveFeature = 'notes' | 'reminders';

const parseArchiveChatId = (raw?: string | null): number | null => {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

export const resolveArchiveChatId = (feature: ArchiveFeature): number | null => {
  const shared = parseArchiveChatId(config.archive.chatId);
  if (shared) return shared;

  if (feature === 'notes') {
    if (!config.notes.archive.enabled) return null;
    return parseArchiveChatId(config.notes.archive.chatId);
  }

  if (!config.reminders.archive.enabled) return null;
  return parseArchiveChatId(config.reminders.archive.chatId);
};

export const archiveCopyFromUser = async (ctx: Context, archiveChatId: number): Promise<number | null> => {
  const sourceChatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id ?? ctx.msg?.message_id;
  if (!sourceChatId || !messageId) return null;

  const archived = await ctx.api.copyMessage(archiveChatId, sourceChatId, messageId);
  return archived.message_id;
};

export const deliverCopyToUser = async (
  ctx: Context,
  params: { userChatId: number; archiveChatId: number; archiveMessageId: number }
): Promise<void> => {
  await ctx.api.copyMessage(params.userChatId, params.archiveChatId, params.archiveMessageId);
};
