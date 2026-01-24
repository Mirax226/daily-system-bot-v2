import type { Api } from 'grammy';
import type { InputMediaAudio, InputMediaDocument, InputMediaPhoto, InputMediaVideo } from 'grammy/types';

import { logWarn } from '../utils/logger';

type AllowedMedia = InputMediaPhoto | InputMediaVideo | InputMediaAudio | InputMediaDocument;

type AttachmentItem = {
  kind: string;
  fileId: string;
  caption?: string;
};

type SendAttachmentsSummary = {
  mediaGroupBatches: number;
  mediaGroupItems: number;
  unsupportedItems: number;
  failures: Array<{ kind: string; fileId: string; error: string }>;
};

const applyCaptionOnlyOnFirst = (media: AllowedMedia[], caption?: string): AllowedMedia[] => {
  if (!caption) return media;
  return media.map((item, index) =>
    index === 0
      ? {
          ...item,
          caption
        }
      : {
          ...item,
          caption: undefined
        }
  );
};

export async function sendAttachmentsAsMedia(
  api: Api,
  chatId: number | string,
  items: AttachmentItem[],
  opts?: { groupCaption?: string }
): Promise<SendAttachmentsSummary> {
  const media: AllowedMedia[] = [];
  const animations: AttachmentItem[] = [];
  const voices: AttachmentItem[] = [];
  const videoNotes: AttachmentItem[] = [];
  const unsupported: AttachmentItem[] = [];
  const failures: Array<{ kind: string; fileId: string; error: string }> = [];

  for (const item of items) {
    switch (item.kind) {
      case 'photo':
        media.push({
          type: 'photo',
          media: item.fileId
        } satisfies InputMediaPhoto);
        break;
      case 'video':
        media.push({
          type: 'video',
          media: item.fileId
        } satisfies InputMediaVideo);
        break;
      case 'audio':
        media.push({
          type: 'audio',
          media: item.fileId
        } satisfies InputMediaAudio);
        break;
      case 'document':
        media.push({
          type: 'document',
          media: item.fileId
        } satisfies InputMediaDocument);
        break;
      case 'animation':
        animations.push(item);
        break;
      case 'voice':
        voices.push(item);
        break;
      case 'video_note':
        videoNotes.push(item);
        break;
      default:
        unsupported.push(item);
        break;
    }
  }

  const mediaWithCaption = applyCaptionOnlyOnFirst(media, opts?.groupCaption);
  for (let i = 0; i < mediaWithCaption.length; i += 10) {
    const chunk = mediaWithCaption.slice(i, i + 10);
    try {
      await api.sendMediaGroup(chatId, chunk);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      for (const entry of chunk) {
        failures.push({ kind: entry.type, fileId: entry.media, error: errorMessage });
      }
      logWarn('Failed to send media group batch', { chatId, error: errorMessage });
    }
  }

  for (const item of animations) {
    try {
      await api.sendAnimation(chatId, item.fileId);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      failures.push({ kind: item.kind, fileId: item.fileId, error: errorMessage });
      logWarn('Failed to send animation attachment', { chatId, error: errorMessage });
    }
  }

  for (const item of voices) {
    try {
      await api.sendVoice(chatId, item.fileId);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      failures.push({ kind: item.kind, fileId: item.fileId, error: errorMessage });
      logWarn('Failed to send voice attachment', { chatId, error: errorMessage });
    }
  }

  for (const item of videoNotes) {
    try {
      await api.sendVideoNote(chatId, item.fileId);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      failures.push({ kind: item.kind, fileId: item.fileId, error: errorMessage });
      logWarn('Failed to send video note attachment', { chatId, error: errorMessage });
    }
  }

  for (const item of unsupported) {
    failures.push({ kind: item.kind, fileId: item.fileId, error: 'Unsupported media kind' });
    logWarn('Skipping unsupported attachment kind', { chatId, kind: item.kind });
  }

  return {
    mediaGroupBatches: Math.ceil(mediaWithCaption.length / 10),
    mediaGroupItems: mediaWithCaption.length,
    unsupportedItems: animations.length + voices.length + videoNotes.length + unsupported.length,
    failures
  };
}
