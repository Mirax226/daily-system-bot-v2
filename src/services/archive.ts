import type { Context } from 'grammy';
import type { Api, ParseMode } from 'grammy';
import { randomUUID } from 'crypto';

import { config } from '../config';
import { getSupabaseClient } from '../db';
import type { ArchiveMessageRow } from '../types/supabase';

export type ArchiveFeature = 'notes' | 'reminders';
export type ArchiveEntityType = 'reminder' | 'note';
export type ArchiveKind = 'desc' | 'attachment';
export type ArchiveMediaType = 'text' | 'photo' | 'video' | 'voice' | 'video_note' | 'document' | 'audio';

const ARCHIVE_TABLE = 'archive_messages';
const ARCHIVE_COPY_DELAY_MS = 200;

const parseArchiveChatId = (raw?: string | null): number | null => {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const clampArchiveChunkSize = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 3500;
  return Math.min(value, 3900);
};

const splitIntoChunks = (text: string, chunkSize: number): string[] => {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + chunkSize));
    cursor += chunkSize;
  }
  return chunks.length ? chunks : [''];
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const resolveArchiveChatId = (_feature?: ArchiveFeature): number | null => {
  if (!config.archive.enabled) return null;
  return parseArchiveChatId(config.archive.chatId);
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

export const recordArchiveMessage = async (
  params: {
    userId: string;
    entityType: ArchiveEntityType;
    entityId: string;
    kind: ArchiveKind;
    mediaType: ArchiveMediaType;
    archiveChatId: number;
    archiveMessageId: number;
    chunkIndex?: number;
    groupKey?: string;
    caption?: string | null;
  },
  client = getSupabaseClient()
): Promise<ArchiveMessageRow> => {
  const groupKey = params.groupKey ?? randomUUID();
  const { data, error } = await client
    .from(ARCHIVE_TABLE)
    .insert({
      user_id: params.userId,
      entity_type: params.entityType,
      entity_id: params.entityId,
      kind: params.kind,
      media_type: params.mediaType,
      archive_chat_id: params.archiveChatId,
      archive_message_id: params.archiveMessageId,
      chunk_index: params.chunkIndex ?? 0,
      group_key: groupKey,
      caption: params.caption ?? null
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to record archive message: ${error.message}`);
  }

  return data as ArchiveMessageRow;
};

export const archiveLongText = async (
  ctx: Context,
  params: { userId: string; entityType: ArchiveEntityType; entityId: string; kind: ArchiveKind; text: string; parseMode?: ParseMode }
): Promise<{ groupKey: string; messageCount: number } | null> => {
  const archiveChatId = resolveArchiveChatId();
  if (!archiveChatId) return null;

  const chunkSize = clampArchiveChunkSize(config.archive.maxChunk);
  const chunks = splitIntoChunks(params.text, chunkSize);
  const groupKey = randomUUID();
  let messageCount = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const archived = await ctx.api.sendMessage(archiveChatId, chunk, params.parseMode ? { parse_mode: params.parseMode } : undefined);
    await recordArchiveMessage({
      userId: params.userId,
      entityType: params.entityType,
      entityId: params.entityId,
      kind: params.kind,
      mediaType: 'text',
      archiveChatId,
      archiveMessageId: archived.message_id,
      chunkIndex: index,
      groupKey
    });
    messageCount += 1;
  }

  return { groupKey, messageCount };
};

const resolveMediaType = (ctx: Context): ArchiveMediaType | null => {
  const message = ctx.message ?? ctx.msg;
  if (!message) return null;
  if ('photo' in message && message.photo && message.photo.length > 0) return 'photo';
  if ('video' in message && message.video) return 'video';
  if ('voice' in message && message.voice) return 'voice';
  if ('video_note' in message && message.video_note) return 'video_note';
  if ('document' in message && message.document) return 'document';
  if ('audio' in message && message.audio) return 'audio';
  return null;
};

export const archiveIncomingMediaMessage = async (
  ctx: Context,
  params: { userId: string; entityType: ArchiveEntityType; entityId: string; kind: ArchiveKind; caption?: string | null }
): Promise<{ groupKey: string; archiveMessageId: number; archiveChatId: number; mediaType: ArchiveMediaType } | null> => {
  const archiveChatId = resolveArchiveChatId();
  if (!archiveChatId) return null;

  const sourceChatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id ?? ctx.msg?.message_id;
  if (!sourceChatId || !messageId) return null;

  const mediaType = resolveMediaType(ctx);
  if (!mediaType) return null;

  const archived = await ctx.api.copyMessage(archiveChatId, sourceChatId, messageId);
  const groupKey = randomUUID();
  await recordArchiveMessage({
    userId: params.userId,
    entityType: params.entityType,
    entityId: params.entityId,
    kind: params.kind,
    mediaType,
    archiveChatId,
    archiveMessageId: archived.message_id,
    groupKey,
    caption: params.caption ?? null
  });

  return { groupKey, archiveMessageId: archived.message_id, archiveChatId, mediaType };
};

export const listArchiveMessagesByGroupKey = async (
  params: { groupKey: string },
  client = getSupabaseClient()
): Promise<ArchiveMessageRow[]> => {
  const { data, error } = await client
    .from(ARCHIVE_TABLE)
    .select('*')
    .eq('group_key', params.groupKey)
    .order('chunk_index', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to load archive group: ${error.message}`);
  }

  return (data as ArchiveMessageRow[]) ?? [];
};

export const listArchiveMessagesByEntity = async (
  params: { entityType: ArchiveEntityType; entityId: string },
  client = getSupabaseClient()
): Promise<ArchiveMessageRow[]> => {
  const { data, error } = await client
    .from(ARCHIVE_TABLE)
    .select('*')
    .eq('entity_type', params.entityType)
    .eq('entity_id', params.entityId)
    .order('created_at', { ascending: true })
    .order('chunk_index', { ascending: true });

  if (error) {
    throw new Error(`Failed to load archive entries: ${error.message}`);
  }

  return (data as ArchiveMessageRow[]) ?? [];
};

const copyArchiveMessagesSequentially = async (
  api: Api,
  params: { userChatId: number; entries: ArchiveMessageRow[] }
): Promise<void> => {
  for (const entry of params.entries) {
    await api.copyMessage(params.userChatId, entry.archive_chat_id, entry.archive_message_id);
    await sleep(ARCHIVE_COPY_DELAY_MS);
  }
};

export const copyArchiveGroupToUser = async (
  ctx: Context,
  params: { userChatId: number; groupKey: string }
): Promise<void> => {
  const entries = await listArchiveMessagesByGroupKey({ groupKey: params.groupKey });
  await copyArchiveMessagesSequentially(ctx.api, { userChatId: params.userChatId, entries });
};

export const copyArchiveEntityToUser = async (
  ctx: Context,
  params: { userChatId: number; entityType: ArchiveEntityType; entityId: string }
): Promise<void> => {
  const entries = await listArchiveMessagesByEntity({ entityType: params.entityType, entityId: params.entityId });
  await copyArchiveMessagesSequentially(ctx.api, { userChatId: params.userChatId, entries });
};
