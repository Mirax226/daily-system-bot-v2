import type { Context } from 'grammy';
import type { Api } from 'grammy';
import { randomUUID } from 'crypto';

import { config } from '../config';
import { getSupabaseClient } from '../db';
import type { ArchiveItemRow, ArchiveMessageRow } from '../types/supabase';

export type ArchiveFeature = 'notes' | 'reminders';
export type ArchiveEntityType = 'reminder' | 'note';
export type ArchiveKind = 'desc' | 'attachment';
export type ArchiveMediaType = 'text' | 'photo' | 'video' | 'voice' | 'video_note' | 'document' | 'audio';
export type ArchiveItemKind = 'note' | 'reminder';
export type ArchiveItemStatus = 'active' | 'deleted' | 'ringed';
export type ArchiveMediaSummary = {
  photos: number;
  videos: number;
  voices: number;
  documents: number;
  video_notes: number;
  audios: number;
};
export type ArchiveAttachmentInput = {
  id?: string;
  kind: ArchiveMediaType;
  fileId: string;
  caption?: string | null;
};
type ParseMode = 'HTML' | 'Markdown' | 'MarkdownV2';

const ARCHIVE_TABLE = 'archive_messages';
const ARCHIVE_ITEMS_TABLE = 'archive_items';
const ARCHIVE_COPY_DELAY_MS = 200;
const ARCHIVE_CAPTION_LIMIT = 900;
const ARCHIVE_SEPARATOR = '➖➖➖➖➖➖➖➖➖➖➖';

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

const archiveRuntime = { enabled: true };

export const resolveArchiveChatId = (_feature?: ArchiveFeature): number | null => {
  if (!config.archive.enabled) return null;
  if (!archiveRuntime.enabled) return null;
  if (config.archive.mode !== 'channel') return null;
  return parseArchiveChatId(config.archive.channelId);
};

export const setArchiveRuntimeStatus = (enabled: boolean): void => {
  archiveRuntime.enabled = enabled;
};

export const validateArchiveChannel = async (api: Api): Promise<{ ok: boolean; reason?: string }> => {
  const chatId = parseArchiveChatId(config.archive.channelId);
  if (!config.archive.enabled) return { ok: false, reason: 'disabled' };
  if (!chatId) return { ok: false, reason: 'missing_channel_id' };
  try {
    const me = await api.getMe();
    const member = await api.getChatMember(chatId, me.id);
    if (member.status === 'administrator' || member.status === 'member') {
      return { ok: true };
    }
    return { ok: false, reason: `invalid_status:${member.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message };
  }
};

const buildArchiveUserLabel = (params: {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  telegramId?: number | null;
}): string => {
  const name = `${params.firstName ?? ''} ${params.lastName ?? ''}`.trim() || 'Unknown';
  const username = params.username ? `(@${params.username})` : '(no username)';
  const id = params.telegramId ? `id:${params.telegramId}` : 'id:—';
  return `${name} ${username} | ${id}`;
};

const formatArchiveSummaryLine = (summary: ArchiveMediaSummary): string => {
  const filesCount = summary.documents + summary.audios;
  return `Photos(${summary.photos}), Videos(${summary.videos}), Voices(${summary.voices}), Files(${filesCount}), VideoNotes(${summary.video_notes})`;
};

const normalizeSummary = (summary?: Partial<ArchiveMediaSummary>): ArchiveMediaSummary => ({
  photos: summary?.photos ?? 0,
  videos: summary?.videos ?? 0,
  voices: summary?.voices ?? 0,
  documents: summary?.documents ?? 0,
  video_notes: summary?.video_notes ?? 0,
  audios: summary?.audios ?? 0
});

const buildArchiveCaption = (params: {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  telegramId?: number | null;
  appUserId: string;
  timeLabel: string;
  kindLabel: string;
  title: string | null;
  description: string | null;
  summary: ArchiveMediaSummary;
}): { caption: string; fullDescriptionText?: string } => {
  const title = params.title && params.title.trim().length > 0 ? params.title.trim() : '—';
  const description = params.description && params.description.trim().length > 0 ? params.description.trim() : '—';
  const headerLines = [
    '🗂️ Archive Item',
    `👤 User: ${buildArchiveUserLabel(params)}`,
    `🆔 AppUser: ${params.appUserId}`,
    `🕒 Time: ${params.timeLabel}`,
    `🧩 Type: ${params.kindLabel}`,
    `🏷️ Title: ${title}`,
    '📝 Description:'
  ];
  const itemsLine = `📎 Items: ${formatArchiveSummaryLine(params.summary)}`;
  const baseLength = headerLines.join('\n').length + itemsLine.length + 2;
  const fullCaption = `${headerLines.join('\n')}\n${description}\n${itemsLine}`;
  if (fullCaption.length <= ARCHIVE_CAPTION_LIMIT) {
    return { caption: fullCaption };
  }
  const notice = '📦 Full description is archived.';
  const available = Math.max(0, ARCHIVE_CAPTION_LIMIT - baseLength - notice.length - 4);
  const truncated = description.length > available ? `${description.slice(0, Math.max(0, available - 1))}…` : description;
  const caption = `${headerLines.join('\n')}\n${truncated}\n${notice}\n${itemsLine}`;
  const fullDescriptionText = `${headerLines.join('\n')}\n${description}\n${itemsLine}`;
  return { caption, fullDescriptionText };
};

const ensureMediaSummary = (attachments: ArchiveAttachmentInput[]): ArchiveMediaSummary => {
  const summary = normalizeSummary();
  for (const attachment of attachments) {
    if (attachment.kind === 'photo') summary.photos += 1;
    if (attachment.kind === 'video') summary.videos += 1;
    if (attachment.kind === 'voice') summary.voices += 1;
    if (attachment.kind === 'document') summary.documents += 1;
    if (attachment.kind === 'video_note') summary.video_notes += 1;
    if (attachment.kind === 'audio') summary.audios += 1;
  }
  return summary;
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

type ArchiveMessageMeta = {
  messageId: number;
  content: string;
  kind: 'caption' | 'text';
};

const mergeSummary = (base: ArchiveMediaSummary, next: ArchiveMediaSummary): ArchiveMediaSummary => ({
  photos: base.photos + next.photos,
  videos: base.videos + next.videos,
  voices: base.voices + next.voices,
  documents: base.documents + next.documents,
  video_notes: base.video_notes + next.video_notes,
  audios: base.audios + next.audios
});

export const getArchiveItemByEntity = async (
  params: { kind: ArchiveItemKind; entityId: string },
  client = getSupabaseClient()
): Promise<ArchiveItemRow | null> => {
  const { data, error } = await client
    .from(ARCHIVE_ITEMS_TABLE)
    .select('*')
    .eq('kind', params.kind)
    .eq('entity_id', params.entityId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load archive item: ${error.message}`);
  }

  return (data as ArchiveItemRow | null) ?? null;
};

export const upsertArchiveItem = async (
  params: {
    existing?: ArchiveItemRow | null;
    ownerUserId: string;
    kind: ArchiveItemKind;
    entityId: string;
    channelId: number;
    title: string | null;
    description: string | null;
    summary: ArchiveMediaSummary;
    messageIds: number[];
    messageMeta: ArchiveMessageMeta[];
    meta?: Record<string, unknown>;
  },
  client = getSupabaseClient()
): Promise<ArchiveItemRow> => {
  const baseMeta = (params.existing?.meta as Record<string, unknown> | null) ?? {};
  const existingMessages = Array.isArray(baseMeta.messages) ? baseMeta.messages : [];
  const nextMessages = [...existingMessages, ...params.messageMeta];
  const mergedMeta = {
    ...baseMeta,
    ...(params.meta ?? {}),
    messages: nextMessages
  };
  const existingMessageIds = Array.isArray(params.existing?.message_ids) ? (params.existing?.message_ids as number[]) : [];
  const mergedMessageIds = [...existingMessageIds, ...params.messageIds];
  const existingSummary = normalizeSummary(params.existing?.media_summary as ArchiveMediaSummary | undefined);
  const mergedSummary = mergeSummary(existingSummary, params.summary);

  if (params.existing) {
    const { data, error } = await client
      .from(ARCHIVE_ITEMS_TABLE)
      .update({
        message_ids: mergedMessageIds,
        media_summary: mergedSummary,
        title: params.title ?? null,
        description: params.description ?? null,
        meta: mergedMeta,
        updated_at: new Date().toISOString()
      })
      .eq('id', params.existing.id)
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to update archive item: ${error.message}`);
    }

    return data as ArchiveItemRow;
  }

  const { data, error } = await client
    .from(ARCHIVE_ITEMS_TABLE)
    .insert({
      owner_user_id: params.ownerUserId,
      kind: params.kind,
      entity_id: params.entityId,
      channel_id: params.channelId,
      message_ids: params.messageIds,
      media_summary: params.summary,
      title: params.title ?? null,
      description: params.description ?? null,
      meta: mergedMeta
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to create archive item: ${error.message}`);
  }

  return data as ArchiveItemRow;
};

const sendArchiveMediaGroup = async (
  api: Api,
  params: {
    archiveChatId: number;
    attachments: ArchiveAttachmentInput[];
    caption: string;
  }
): Promise<{ messageIds: number[]; attachmentMessageIds: Map<string, number> }> => {
  const messageIds: number[] = [];
  const attachmentMessageIds = new Map<string, number>();
  if (!params.attachments.length) return { messageIds, attachmentMessageIds };
  const media = params.attachments.map((attachment) => ({
    type: attachment.kind === 'photo' ? 'photo' : 'video',
    media: attachment.fileId,
    caption: params.caption
  })) as Array<{ type: 'photo' | 'video'; media: string; caption: string }>;
  const messages = await api.sendMediaGroup(params.archiveChatId, media);
  messages.forEach((message: { message_id: number }, index: number) => {
    messageIds.push(message.message_id);
    const attachment = params.attachments[index];
    if (attachment?.id) attachmentMessageIds.set(attachment.id, message.message_id);
  });
  return { messageIds, attachmentMessageIds };
};

const sendArchiveSingleMedia = async (
  api: Api,
  params: { archiveChatId: number; attachment: ArchiveAttachmentInput; caption: string }
): Promise<{ messageIds: number[]; messageMeta: ArchiveMessageMeta[]; attachmentMessageId: number }> => {
  const { attachment } = params;
  if (attachment.kind === 'voice') {
    const message = await api.sendVoice(params.archiveChatId, attachment.fileId, { caption: params.caption });
    return {
      messageIds: [message.message_id],
      messageMeta: [{ messageId: message.message_id, content: params.caption, kind: 'caption' }],
      attachmentMessageId: message.message_id
    };
  }
  if (attachment.kind === 'video_note') {
    const captionMessage = await api.sendMessage(params.archiveChatId, params.caption);
    const message = await api.sendVideoNote(params.archiveChatId, attachment.fileId);
    return {
      messageIds: [captionMessage.message_id, message.message_id],
      messageMeta: [{ messageId: captionMessage.message_id, content: params.caption, kind: 'text' }],
      attachmentMessageId: message.message_id
    };
  }
  if (attachment.kind === 'audio') {
    const message = await api.sendAudio(params.archiveChatId, attachment.fileId, { caption: params.caption });
    return {
      messageIds: [message.message_id],
      messageMeta: [{ messageId: message.message_id, content: params.caption, kind: 'caption' }],
      attachmentMessageId: message.message_id
    };
  }
  if (attachment.kind === 'document') {
    const message = await api.sendDocument(params.archiveChatId, attachment.fileId, { caption: params.caption });
    return {
      messageIds: [message.message_id],
      messageMeta: [{ messageId: message.message_id, content: params.caption, kind: 'caption' }],
      attachmentMessageId: message.message_id
    };
  }
  const message = await api.sendMessage(params.archiveChatId, params.caption);
  return {
    messageIds: [message.message_id],
    messageMeta: [{ messageId: message.message_id, content: params.caption, kind: 'text' }],
    attachmentMessageId: message.message_id
  };
};

export const sendArchiveItemToChannel = async (
  api: Api,
  params: {
    archiveChatId: number;
    user: { firstName?: string | null; lastName?: string | null; username?: string | null; telegramId?: number | null; appUserId: string };
    timeLabel: string;
    kindLabel: string;
    title: string | null;
    description: string | null;
    attachments: ArchiveAttachmentInput[];
  }
): Promise<{
  summary: ArchiveMediaSummary;
  messageIds: number[];
  attachmentMessageIds: Map<string, number>;
  messageMeta: ArchiveMessageMeta[];
}> => {
  const summary = ensureMediaSummary(params.attachments);
  const captionResult = buildArchiveCaption({
    firstName: params.user.firstName,
    lastName: params.user.lastName,
    username: params.user.username,
    telegramId: params.user.telegramId,
    appUserId: params.user.appUserId,
    timeLabel: params.timeLabel,
    kindLabel: params.kindLabel,
    title: params.title,
    description: params.description,
    summary
  });
  const messageIds: number[] = [];
  const attachmentMessageIds = new Map<string, number>();
  const messageMeta: ArchiveMessageMeta[] = [];

  const photos = params.attachments.filter((attachment) => attachment.kind === 'photo');
  const videos = params.attachments.filter((attachment) => attachment.kind === 'video');
  const others = params.attachments.filter((attachment) => attachment.kind !== 'photo' && attachment.kind !== 'video');

  if (photos.length) {
    const result = await sendArchiveMediaGroup(api, { archiveChatId: params.archiveChatId, attachments: photos, caption: captionResult.caption });
    messageIds.push(...result.messageIds);
    result.attachmentMessageIds.forEach((value, key) => attachmentMessageIds.set(key, value));
    result.messageIds.forEach((messageId) => messageMeta.push({ messageId, content: captionResult.caption, kind: 'caption' }));
  }

  if (videos.length) {
    const result = await sendArchiveMediaGroup(api, { archiveChatId: params.archiveChatId, attachments: videos, caption: captionResult.caption });
    messageIds.push(...result.messageIds);
    result.attachmentMessageIds.forEach((value, key) => attachmentMessageIds.set(key, value));
    result.messageIds.forEach((messageId) => messageMeta.push({ messageId, content: captionResult.caption, kind: 'caption' }));
  }

  for (const attachment of others) {
    const result = await sendArchiveSingleMedia(api, { archiveChatId: params.archiveChatId, attachment, caption: captionResult.caption });
    messageIds.push(...result.messageIds);
    if (attachment.id) attachmentMessageIds.set(attachment.id, result.attachmentMessageId);
    messageMeta.push(...result.messageMeta);
  }

  if (captionResult.fullDescriptionText) {
    const descMessage = await api.sendMessage(params.archiveChatId, captionResult.fullDescriptionText);
    messageIds.push(descMessage.message_id);
    messageMeta.push({ messageId: descMessage.message_id, content: captionResult.fullDescriptionText, kind: 'text' });
  }

  const separator = await api.sendMessage(params.archiveChatId, ARCHIVE_SEPARATOR);
  messageIds.push(separator.message_id);
  messageMeta.push({ messageId: separator.message_id, content: ARCHIVE_SEPARATOR, kind: 'text' });

  return { summary, messageIds, attachmentMessageIds, messageMeta };
};

export const markArchiveItemStatus = async (
  api: Api,
  params: {
    item: ArchiveItemRow;
    status: ArchiveItemStatus;
    statusNote: string;
    statusLine: string;
  },
  client = getSupabaseClient()
): Promise<ArchiveItemRow> => {
  const meta = (params.item.meta as Record<string, unknown> | null) ?? {};
  const messages = Array.isArray(meta.messages) ? (meta.messages as ArchiveMessageMeta[]) : [];
  const messageIds = Array.isArray(params.item.message_ids) ? (params.item.message_ids as number[]) : [];
  const appendedMessageIds: number[] = [];
  const appendedMeta: ArchiveMessageMeta[] = [];

  for (const message of messages) {
    const updatedContent = `${message.content}\n${params.statusLine}`;
    if (message.kind === 'caption') {
      if (updatedContent.length > 1024) {
        const note = await api.sendMessage(params.item.channel_id, params.statusLine);
        appendedMessageIds.push(note.message_id);
        appendedMeta.push({ messageId: note.message_id, content: params.statusLine, kind: 'text' });
        continue;
      }
      try {
        await api.editMessageCaption(params.item.channel_id, message.messageId, { caption: updatedContent });
      } catch {
        const note = await api.sendMessage(params.item.channel_id, params.statusLine);
        appendedMessageIds.push(note.message_id);
        appendedMeta.push({ messageId: note.message_id, content: params.statusLine, kind: 'text' });
      }
      continue;
    }

    if (updatedContent.length > 3800) {
      const note = await api.sendMessage(params.item.channel_id, params.statusLine);
      appendedMessageIds.push(note.message_id);
      appendedMeta.push({ messageId: note.message_id, content: params.statusLine, kind: 'text' });
      continue;
    }
    try {
      await api.editMessageText(params.item.channel_id, message.messageId, updatedContent);
    } catch {
      const note = await api.sendMessage(params.item.channel_id, params.statusLine);
      appendedMessageIds.push(note.message_id);
      appendedMeta.push({ messageId: note.message_id, content: params.statusLine, kind: 'text' });
    }
  }

  const mergedMessages = [...messages, ...appendedMeta];
  const mergedMessageIds = [...messageIds, ...appendedMessageIds];

  const { data, error } = await client
    .from(ARCHIVE_ITEMS_TABLE)
    .update({
      status: params.status,
      status_note: params.statusNote,
      message_ids: mergedMessageIds,
      meta: { ...meta, messages: mergedMessages },
      updated_at: new Date().toISOString()
    })
    .eq('id', params.item.id)
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to update archive status: ${error.message}`);
  }

  return data as ArchiveItemRow;
};
