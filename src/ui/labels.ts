import { t, type Locale } from '../i18n';
import { btn, clockEmojiFromTime, emoji, type EmojiKey, isEmojiEnabled, withEmoji } from './emoji';

export type NoteCaptionCategory = 'photo' | 'video' | 'voice' | 'video_note' | 'files';
export type NoteAttachmentKind = 'photo' | 'video' | 'voice' | 'video_note' | 'document' | 'audio';

const captionCategoryEmojiKey = (category: NoteCaptionCategory): EmojiKey => {
  if (category === 'photo') return 'photo';
  if (category === 'video') return 'video';
  if (category === 'voice') return 'voice';
  if (category === 'video_note') return 'video_note';
  return 'file';
};

const attachmentKindEmojiKey = (kind: NoteAttachmentKind): EmojiKey => {
  if (kind === 'photo') return 'photo';
  if (kind === 'video') return 'video';
  if (kind === 'voice') return 'voice';
  if (kind === 'video_note') return 'video_note';
  return 'file';
};

export const labels = {
  nav: {
    notes: (locale?: Locale) => btn('notes', t('buttons.notes', undefined, locale)),
    freeText: (locale?: Locale) => btn('notes', t('buttons.nav_free_text', undefined, locale)),
    reminders: (locale?: Locale) => btn('reminders', t('buttons.nav_reminders', undefined, locale))
  },
  notes: {
    title: () => withEmoji('notes', t('screens.notes.title')),
    todayEmpty: () => withEmoji('notes', t('screens.notes.today_empty')),
    todayHeader: () => withEmoji('notes', t('screens.notes.today_header')),
    todayItemLine: (params: { time: string; title: string }) =>
      isEmojiEnabled() ? `${emoji('clock')} ${params.time} — ${emoji('noteDetails')} ${params.title}` : `${params.time} — ${params.title}`,
    historyTitle: () => withEmoji('history', t('screens.notes.history_title')),
    historyEmpty: () => withEmoji('history', t('screens.notes.history_empty')),
    historyItemLine: (params: { date: string; count: string }) => {
      const line = t('screens.notes.history_item_line', params);
      return isEmojiEnabled() ? `${emoji('calendar')} ${line}` : line;
    },
    historyOpenHint: () => withEmoji('info', t('screens.notes.history_open_hint')),
    dateTitle: (params: { date: string }) => withEmoji('calendar', t('screens.notes.date_title', params)),
    dateItemLine: (params: { time: string; title: string }) =>
      isEmojiEnabled() ? `${emoji('clock')} ${params.time} — ${emoji('noteDetails')} ${params.title}` : `${params.time} — ${params.title}`,
    viewEmpty: () => withEmoji('notes', t('screens.notes.view_empty')),
    detailTitleLabel: () => withEmoji('noteDetails', t('screens.notes.detail_title_label')),
    detailDate: (params: { date: string }) => withEmoji('calendar', t('screens.notes.detail_date', params)),
    detailTime: (params: { time: string }) => withEmoji('clock', t('screens.notes.detail_time', params)),
    detailTitle: (params: { title: string }) => withEmoji('title', t('screens.notes.detail_title', params)),
    attachmentsSummary: (params: { count: string }) => withEmoji('items', t('screens.notes.attachments_summary', params)),
    detailArchivedNotice: () => withEmoji('archive', t('screens.notes.detail_archived_notice')),
    attachmentsPrompt: () => withEmoji('attach', t('screens.notes.attachments_prompt')),
    attachmentsIdlePrompt: () => withEmoji('save', t('screens.notes.attachments_idle_prompt')),
    captionsSummary: (params: { summary: string }) => withEmoji('items', t('screens.notes.captions_summary', params)),
    captionsPrompt: () => withEmoji('description', t('screens.notes.captions_prompt')),
    captionAllPrompt: () => withEmoji('description', t('screens.notes.caption_all_prompt')),
    captionCategoryPrompt: (params: { category: string }) => withEmoji('description', t('screens.notes.caption_category_prompt', params)),
    attachmentsTitle: (params: { kind: string }) => withEmoji('attach', t('screens.notes.attachments_title', params)),
    attachmentsHeader: (params: { kind: string }) => withEmoji('attach', t('screens.notes.attachments_header', params)),
    attachmentsEmpty: (params: { kind: string }) => withEmoji('attach', t('screens.notes.attachments_empty', params)),
    attachmentLine: (params: { index: string; time: string; caption: string }) => {
      const line = t('screens.notes.attachment_line', params);
      return isEmojiEnabled() ? `${emoji('info')} ${line}` : line;
    },
    attachmentNoCaption: () => t('screens.notes.attachment_no_caption'),
    attachmentSendFailed: () => withEmoji('warning', t('screens.notes.attachment_send_failed')),
    attachmentsFailed: () => withEmoji('warning', t('screens.notes.attachments_failed')),
    askTitle: () => withEmoji('edit', t('screens.notes.ask_title')),
    askBody: () => withEmoji('description', t('screens.notes.ask_body')),
    saving: () => withEmoji('processing', t('screens.notes.saving')),
    saved: () => withEmoji('save', t('screens.notes.saved')),
    previewDate: (params: { date: string }) => withEmoji('calendar', t('screens.notes.preview_date', params)),
    previewTitle: (params: { title: string }) => withEmoji('title', t('screens.notes.preview_title', params)),
    previewBody: (params: { preview: string }) => withEmoji('description', t('screens.notes.preview_body', params)),
    descriptionLabel: () => withEmoji('description', t('screens.notes.description_label')),
    untitled: () => t('screens.notes.untitled'),
    clearConfirm: () => withEmoji('warning', t('screens.notes.clear_confirm')),
    editMenuTitle: () => withEmoji('edit', t('screens.notes.edit_menu_title')),
    editing: (params: { title: string }) => withEmoji('edit', t('screens.notes.editing', params)),
    editTitlePrompt: () => withEmoji('edit', t('screens.notes.edit_title_prompt')),
    editBodyPrompt: () => withEmoji('description', t('screens.notes.edit_body_prompt')),
    kindLabel: (kind: NoteAttachmentKind) => {
      if (kind === 'document' || kind === 'audio') {
        return t('screens.notes.kind_files');
      }
      return t(`screens.notes.kind_${kind}`);
    },
    captionLabel: (category: NoteCaptionCategory) => withEmoji(captionCategoryEmojiKey(category), t(`screens.notes.caption_${category}`)),
    captionHeader: (category: NoteCaptionCategory) => withEmoji(captionCategoryEmojiKey(category), t(`screens.notes.caption_header_${category}`))
  },
  notesButtons: {
    add: () => btn('new', t('buttons.notes_add')),
    history: () => btn('history', t('buttons.notes_history')),
    back: () => btn('back', t('buttons.notes_back')),
    clearToday: () => btn('delete', t('buttons.notes_clear_today')),
    prev: () => btn('back', t('buttons.notes_prev')),
    next: () => btn('view', t('buttons.notes_next')),
    viewFull: () => btn('view', t('buttons.notes_view_full')),
    edit: () => btn('edit', t('buttons.notes_edit')),
    attach: () => btn('attach', t('buttons.notes_attach')),
    delete: () => btn('delete', t('buttons.notes_delete')),
    viewAllItems: () => btn('archive', t('buttons.notes_view_all')),
    photo: () => btn('photo', t('buttons.notes_photo')),
    video: () => btn('video', t('buttons.notes_video')),
    voice: () => btn('voice', t('buttons.notes_voice')),
    document: () => btn('file', t('buttons.notes_document')),
    editTitle: () => btn('edit', t('buttons.notes_edit_title')),
    editBody: () => btn('description', t('buttons.notes_edit_body')),
    attachDone: () => btn('save', t('buttons.notes_attach_done')),
    attachCancel: () => btn('cancel', t('buttons.notes_attach_cancel')),
    captionAll: () => btn('description', t('buttons.notes_caption_all')),
    captionByCategory: () => btn('items', t('buttons.notes_caption_by_category')),
    captionSkip: () => btn('cancel', t('buttons.notes_caption_skip')),
    skip: () => btn('cancel', t('buttons.notes_skip')),
    cancel: () => btn('cancel', t('buttons.notes_cancel')),
    confirmClear: () => btn('ok', t('buttons.notes_confirm_clear')),
    saveNow: () => btn('save', t('buttons.notes_save_now')),
    continue: () => btn('new', t('buttons.notes_continue'))
  },
  reminders: {
    title: () => withEmoji('reminders', t('screens.reminders.title')),
    empty: () => withEmoji('reminders', t('screens.reminders.empty')),
    listHeader: () => withEmoji('reminders', t('screens.reminders.list_header')),
    itemLine: (params: { status: string; time: string; title: string; attachments: string }) => {
      const line = t('screens.reminders.item_line', params);
      return isEmojiEnabled() ? `${emoji('reminders')} ${line}` : line;
    },
    statusOn: () => t('screens.reminders.status_on'),
    statusOff: () => t('screens.reminders.status_off'),
    statusOnLabel: () => withEmoji('toggleOn', t('screens.reminders.status_on')),
    statusOffLabel: () => withEmoji('toggleOff', t('screens.reminders.status_off')),
    noTime: () => withEmoji('clock', t('screens.reminders.no_time')),
    actionsHint: () => withEmoji('info', t('screens.reminders.actions_hint')),
    newTitle: () => withEmoji('reminders', t('screens.reminders.new_title')),
    newChooseDate: () => withEmoji('calendar', t('screens.reminders.new_choose_date')),
    newEnterTitle: () => withEmoji('edit', t('screens.reminders.new_enter_title')),
    descriptionPrompt: () => withEmoji('description', t('screens.reminders.description_prompt')),
    attachmentsIdlePrompt: () => withEmoji('save', t('screens.reminders.attachments_idle_prompt')),
    newInvalidTime: () => withEmoji('warning', t('screens.reminders.new_invalid_time')),
    newInvalidDate: () => withEmoji('warning', t('screens.reminders.new_invalid_date')),
    newCreated: (params: { local_date: string; local_time: string }) => withEmoji('ok', t('screens.reminders.new_created', params)),
    titleSaveFailed: () => withEmoji('warning', t('screens.reminders.title_save_failed')),
    saving: () => withEmoji('processing', t('screens.reminders.saving')),
    saved: () => withEmoji('save', t('screens.reminders.saved')),
    deleteConfirm: () => withEmoji('warning', t('screens.reminders.delete_confirm')),
    detailsTitle: (params: { time?: string | null }) => {
      if (!params.time) return withEmoji('reminders', t('screens.reminders.details_title'));
      if (!isEmojiEnabled()) return t('screens.reminders.details_title');
      return `${clockEmojiFromTime(params.time)} ${t('screens.reminders.details_title')}`;
    },
    detailsTitleLine: (params: { title: string }) => withEmoji('title', t('screens.reminders.details_title_line', params)),
    detailsDetailLine: (params: { detail: string }) => withEmoji('description', t('screens.reminders.details_detail_line', params)),
    detailsScheduleLine: (params: { schedule: string }) => withEmoji('calendar', t('screens.reminders.details_schedule_line', params)),
    detailsScheduledLine: (params: { scheduled: string }) => withEmoji('clock', t('screens.reminders.details_scheduled_line', params)),
    detailsStatusLine: (params: { status: string; enabled: boolean }) =>
      withEmoji(params.enabled ? 'toggleOn' : 'toggleOff', t('screens.reminders.details_status_line', { status: params.status })),
    detailsAttachmentsLine: (params: { count: string }) => withEmoji('items', t('screens.reminders.details_attachments_line', params)),
    detailsArchivedNotice: () => withEmoji('archive', t('screens.reminders.details_archived_notice')),
    detailsEmpty: () => t('screens.reminders.details_empty'),
    editTitlePrompt: () => withEmoji('edit', t('screens.reminders.edit_title_prompt')),
    editDetailPrompt: () => withEmoji('description', t('screens.reminders.edit_detail_prompt')),
    editSaved: () => withEmoji('save', t('screens.reminders.edit_saved')),
    scheduleTypePrompt: () => withEmoji('calendar', t('screens.reminders.schedule_type_prompt')),
    scheduleOnce: () => withEmoji('clock', t('screens.reminders.schedule_once')),
    scheduleHourly: () => withEmoji('clock', t('screens.reminders.schedule_hourly')),
    scheduleDaily: () => withEmoji('calendar', t('screens.reminders.schedule_daily')),
    scheduleWeekly: () => withEmoji('calendar', t('screens.reminders.schedule_weekly')),
    scheduleMonthly: () => withEmoji('calendar', t('screens.reminders.schedule_monthly')),
    scheduleYearly: () => withEmoji('calendar', t('screens.reminders.schedule_yearly')),
    scheduleTypeLabel: (key: string) => t(`screens.reminders.schedule_type_${key}`),
    intervalPrompt: () => withEmoji('clock', t('screens.reminders.interval_prompt')),
    intervalInvalid: () => withEmoji('warning', t('screens.reminders.interval_invalid')),
    dailyTimePrompt: () => withEmoji('clock', t('screens.reminders.daily_time_prompt')),
    weeklyDayPrompt: () => withEmoji('calendar', t('screens.reminders.weekly_day_prompt')),
    monthlyDayPrompt: () => withEmoji('calendar', t('screens.reminders.monthly_day_prompt')),
    monthlyDayInvalid: () => withEmoji('warning', t('screens.reminders.monthly_day_invalid')),
    yearlyMonthPrompt: () => withEmoji('calendar', t('screens.reminders.yearly_month_prompt')),
    attachmentsPrompt: () => withEmoji('attach', t('screens.reminders.attachments_prompt')),
    attachmentsFailed: () => withEmoji('warning', t('screens.reminders.attachments_failed')),
    untitled: () => t('screens.reminders.untitled'),
    customDateTitle: (params: { mode: string }) => withEmoji('calendar', t('screens.reminders.custom_date_title', params)),
    customDateCurrent: (params: { date: string }) => withEmoji('calendar', t('screens.reminders.custom_date_current', params)),
    customDateHint: () => withEmoji('info', t('screens.reminders.custom_date_hint')),
    customDateManualPrompt: () => withEmoji('edit', t('screens.reminders.custom_date_manual_prompt')),
    weekendDayPrompt: () => withEmoji('calendar', t('screens.reminders.weekend_day_prompt')),
    timeTitle: () => withEmoji('clock', t('screens.reminders.time_title')),
    timeCurrent: (params: { time: string }) => withEmoji('clock', t('screens.reminders.time_current', params)),
    timeManualPrompt: () => withEmoji('edit', t('screens.reminders.time_manual_prompt')),
    messageTitle: (params: { title: string }) => withEmoji('reminders', t('screens.reminders.message_title', params)),
    messageArchivedNotice: () => withEmoji('file', t('screens.reminders.message_archived_notice'))
  },
  remindersButtons: {
    new: () => btn('new', t('buttons.reminders_new')),
    edit: () => btn('edit', t('buttons.reminders_edit')),
    toggleOn: () => btn('toggleOn', t('buttons.reminders_toggle_on')),
    toggleOff: () => btn('toggleOff', t('buttons.reminders_toggle_off')),
    delete: () => btn('delete', t('buttons.reminders_delete')),
    back: () => btn('back', t('buttons.reminders_back')),
    viewFull: () => btn('view', t('buttons.reminders_view_full')),
    editTitle: () => btn('edit', t('buttons.reminders_edit_title')),
    editDetail: () => btn('description', t('buttons.reminders_edit_detail')),
    editSchedule: () => btn('calendar', t('buttons.reminders_edit_schedule')),
    attach: () => btn('attach', t('buttons.reminders_attach')),
    descriptionDone: () => btn('ok', t('buttons.reminders_description_done')),
    editDate: () => btn('calendar', t('buttons.reminders_edit_date')),
    editTime: () => btn('clock', t('buttons.reminders_edit_time')),
    today: () => btn('calendar', t('buttons.reminders_today')),
    tomorrow: () => btn('calendar', t('buttons.reminders_tomorrow')),
    weekend: () => btn('calendar', t('buttons.reminders_weekend')),
    customDate: () => btn('calendar', t('buttons.reminders_custom_date')),
    weekendDay: (params: { day: string }) => btn('settings', t('buttons.reminders_weekend_day', params)),
    useGregorian: () => btn('calendar', t('buttons.reminders_use_gregorian')),
    useJalali: () => btn('calendar', t('buttons.reminders_use_jalali')),
    typeDate: () => btn('edit', t('buttons.reminders_type_date')),
    dateConfirm: () => btn('ok', t('buttons.reminders_date_confirm')),
    typeTime: () => btn('edit', t('buttons.reminders_type_time')),
    timeConfirm: () => btn('ok', t('buttons.reminders_time_confirm'))
  },
  settings: {
    title: () => withEmoji('settings', t('screens.settings.title')),
    emojiToggleLabel: (enabled: boolean) =>
      t('buttons.settings_emoji_toggle', { state: enabled ? 'ON' : 'OFF' })
  },
  settingsButtons: {
    emojiToggle: (enabled: boolean) =>
      btn(enabled ? 'toggleOn' : 'toggleOff', t('buttons.settings_emoji_toggle', { state: enabled ? 'ON' : 'OFF' })),
    back: () => btn('back', t('buttons.notes_back'))
  },
  archive: {
    header: () => withEmoji('archive', t('archive.header')),
    userLine: (params: { label: string }) => withEmoji('user', t('archive.user', params)),
    appUserLine: (params: { id: string }) => withEmoji('id', t('archive.app_user', params)),
    timeLine: (params: { time: string }) => withEmoji('clock', t('archive.time', params)),
    typeLine: (params: { type: string }) => withEmoji('type', t('archive.type', params)),
    titleLine: (params: { title: string }) => withEmoji('title', t('archive.title', params)),
    descriptionLabel: () => withEmoji('description', t('archive.description')),
    itemsLine: (params: { summary: string }) => withEmoji('items', t('archive.items', params)),
    descriptionArchivedNotice: () => withEmoji('archive', t('archive.description_archived_notice')),
    kindNote: () => t('archive.kind_note'),
    kindReminder: () => t('archive.kind_reminder'),
    deletedBy: (params: { user: string }) => withEmoji('delete', t('archive.deleted_by', params)),
    separator: () => t('archive.separator'),
    summaryLine: (params: { photos: number; videos: number; voices: number; files: number; videoNotes: number }) =>
      t('archive.summary_line', {
        photos: String(params.photos),
        videos: String(params.videos),
        voices: String(params.voices),
        files: String(params.files),
        videoNotes: String(params.videoNotes)
      })
  }
};
