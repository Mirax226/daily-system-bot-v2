import { InputFile, type Api, type Context } from 'grammy';
import type { InputMediaPhoto, InputMediaVideo } from 'grammy/types';

import { safePlain, truncateTelegram } from '../ui/text';
import { logWarn } from '../utils/logger';

export type MediaKind = 'photo' | 'video' | 'voice' | 'document' | 'video_note' | 'animation' | 'audio';

export type StoredAttachment = {
  kind: MediaKind;
  fileId: string;
  caption?: string | null;
};

export type SendResult = {
  sentMessageIds: number[];
  groups: { kind: 'album' | 'single'; count: number }[];
};

type AlbumMedia = InputMediaPhoto<InputFile> | InputMediaVideo<InputFile>;

type AlbumCandidate = StoredAttachment & { kind: 'photo' | 'video' };

const MAX_CAPTION_LENGTH = 900;

const normalizeCaption = (caption?: string | null): string | undefined => {
  if (!caption) return undefined;
  const trimmed = truncateTelegram(safePlain(caption), MAX_CAPTION_LENGTH).trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const isAlbumCandidate = (attachment: StoredAttachment): attachment is AlbumCandidate =>
  attachment.kind === 'photo' || attachment.kind === 'video';

export function buildAlbumMedia(items: StoredAttachment[], caption?: string): ReadonlyArray<AlbumMedia> {
  const candidates = items.filter(isAlbumCandidate);
  if (candidates.length === 0) return [];
  const albumCaption = normalizeCaption(caption);

  return candidates.map((attachment, index) => {
    if (attachment.kind === 'photo') {
      const media: InputMediaPhoto<InputFile> = {
        type: 'photo',
        media: attachment.fileId
      };
      if (index === 0 && albumCaption) {
        media.caption = albumCaption;
      }
      return media;
    }

    const media: InputMediaVideo<InputFile> = {
      type: 'video',
      media: attachment.fileId
    };
    if (index === 0 && albumCaption) {
      media.caption = albumCaption;
    }
    return media;
  });
}

export async function sendAttachments(
  ctx: Context,
  chatId: number,
  attachments: StoredAttachment[],
  options?: { captionBlock?: string }
): Promise<SendResult> {
  return sendAttachmentsWithApi(ctx.api, chatId, attachments, options);
}

export async function sendAttachmentsWithApi(
  api: Api,
  chatId: number,
  attachments: StoredAttachment[],
  options?: { captionBlock?: string }
): Promise<SendResult> {
  const sentMessageIds: number[] = [];
  const groups: { kind: 'album' | 'single'; count: number }[] = [];

  const albumCandidates = attachments.filter(isAlbumCandidate);
  const remaining = attachments.filter((attachment) => !isAlbumCandidate(attachment));
  const albumCaption = normalizeCaption(options?.captionBlock);

  const albumMedia = buildAlbumMedia(albumCandidates, albumCaption);
  for (let i = 0; i < albumMedia.length; i += 10) {
    const chunk = albumMedia.slice(i, i + 10) as ReadonlyArray<AlbumMedia>;
    try {
      const messages = await api.sendMediaGroup(chatId, chunk);
      messages.forEach((message) => sentMessageIds.push(message.message_id));
      groups.push({ kind: 'album', count: chunk.length });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logWarn('Failed to send media group', { chatId, error: errorMessage });
    }
  }

  for (const attachment of remaining) {
    const caption = normalizeCaption(attachment.caption ?? options?.captionBlock);
    try {
      if (attachment.kind === 'voice') {
        const message = await api.sendVoice(chatId, attachment.fileId, caption ? { caption } : undefined);
        sentMessageIds.push(message.message_id);
        groups.push({ kind: 'single', count: 1 });
        continue;
      }
      if (attachment.kind === 'video_note') {
        const message = await api.sendVideoNote(chatId, attachment.fileId);
        sentMessageIds.push(message.message_id);
        groups.push({ kind: 'single', count: 1 });
        if (caption) {
          const captionMessage = await api.sendMessage(chatId, caption);
          sentMessageIds.push(captionMessage.message_id);
        }
        continue;
      }
      if (attachment.kind === 'document') {
        const message = await api.sendDocument(chatId, attachment.fileId, caption ? { caption } : undefined);
        sentMessageIds.push(message.message_id);
        groups.push({ kind: 'single', count: 1 });
        continue;
      }
      if (attachment.kind === 'audio') {
        const message = await api.sendAudio(chatId, attachment.fileId, caption ? { caption } : undefined);
        sentMessageIds.push(message.message_id);
        groups.push({ kind: 'single', count: 1 });
        continue;
      }
      if (attachment.kind === 'animation') {
        const message = await api.sendAnimation(chatId, attachment.fileId, caption ? { caption } : undefined);
        sentMessageIds.push(message.message_id);
        groups.push({ kind: 'single', count: 1 });
        continue;
      }
      const message = await api.sendDocument(chatId, attachment.fileId, caption ? { caption } : undefined);
      sentMessageIds.push(message.message_id);
      groups.push({ kind: 'single', count: 1 });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logWarn('Failed to send attachment', { chatId, kind: attachment.kind, error: errorMessage });
    }
  }

  return { sentMessageIds, groups };
}
