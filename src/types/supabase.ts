export type Database = {
  public: {
    Tables: {
      users: {
        Row: {
          id: string;
          telegram_id: string;
          username: string | null;
          timezone: string;
          home_chat_id: string | null;
          home_message_id: string | null;
          settings_json: Record<string, unknown>;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          telegram_id: string;
          username?: string | null;
          timezone?: string;
          home_chat_id?: string | null;
          home_message_id?: string | null;
          settings_json?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          telegram_id?: string;
          username?: string | null;
          timezone?: string;
          home_chat_id?: string | null;
          home_message_id?: string | null;
          settings_json?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      archive_messages: {
        Row: {
          id: string;
          user_id: string;
          entity_type: string;
          entity_id: string;
          kind: string;
          media_type: string;
          archive_chat_id: number;
          archive_message_id: number;
          chunk_index: number;
          group_key: string;
          caption: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          entity_type: string;
          entity_id: string;
          kind: string;
          media_type: string;
          archive_chat_id: number;
          archive_message_id: number;
          chunk_index?: number;
          group_key?: string;
          caption?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          entity_type?: string;
          entity_id?: string;
          kind?: string;
          media_type?: string;
          archive_chat_id?: number;
          archive_message_id?: number;
          chunk_index?: number;
          group_key?: string;
          caption?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'archive_messages_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          }
        ];
      };
      reminders: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          detail: string | null;
          description: string | null;
          desc_group_key: string | null;
          schedule_type: string;
          timezone: string;
          next_run_at: string | null;
          is_active: boolean;
          deleted_at: string | null;
          deleted_by: string | null;
          once_at: string | null;
          interval_minutes: number | null;
          at_time: string | null;
          by_weekday: number | null;
          by_monthday: number | null;
          by_month: number | null;
          next_run_at_utc: string | null;
          last_sent_at_utc: string | null;
          enabled: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title: string;
          detail?: string | null;
          description?: string | null;
          desc_group_key?: string | null;
          schedule_type?: string;
          timezone?: string;
          next_run_at?: string | null;
          is_active?: boolean;
          deleted_at?: string | null;
          deleted_by?: string | null;
          once_at?: string | null;
          interval_minutes?: number | null;
          at_time?: string | null;
          by_weekday?: number | null;
          by_monthday?: number | null;
          by_month?: number | null;
          next_run_at_utc?: string | null;
          last_sent_at_utc?: string | null;
          enabled?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          title?: string;
          detail?: string | null;
          description?: string | null;
          desc_group_key?: string | null;
          schedule_type?: string;
          timezone?: string;
          next_run_at?: string | null;
          is_active?: boolean;
          deleted_at?: string | null;
          deleted_by?: string | null;
          once_at?: string | null;
          interval_minutes?: number | null;
          at_time?: string | null;
          by_weekday?: number | null;
          by_monthday?: number | null;
          by_month?: number | null;
          next_run_at_utc?: string | null;
          last_sent_at_utc?: string | null;
          enabled?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      notes: {
        Row: {
          id: string;
          user_id: string;
          note_date: string;
          title: string | null;
          body: string;
          content_group_key: string | null;
          created_at: string;
          deleted_at: string | null;
          deleted_by: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          note_date: string;
          title?: string | null;
          body: string;
          content_group_key?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          note_date?: string;
          title?: string | null;
          body?: string;
          content_group_key?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          deleted_by?: string | null;
        };
        Relationships: [];
      };
      note_attachments: {
        Row: {
          id: string;
          note_id: string;
          kind: string;
          file_id: string;
          file_unique_id: string | null;
          caption: string | null;
          created_at: string;
          archive_chat_id: number | null;
          archive_message_id: number | null;
          caption_pending: boolean;
        };
        Insert: {
          id?: string;
          note_id: string;
          kind: string;
          file_id: string;
          file_unique_id?: string | null;
          caption?: string | null;
          created_at?: string;
          archive_chat_id?: number | null;
          archive_message_id?: number | null;
          caption_pending?: boolean;
        };
        Update: {
          id?: string;
          note_id?: string;
          kind?: string;
          file_id?: string;
          file_unique_id?: string | null;
          caption?: string | null;
          created_at?: string;
          archive_chat_id?: number | null;
          archive_message_id?: number | null;
          caption_pending?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: 'note_attachments_note_id_fkey';
            columns: ['note_id'];
            isOneToOne: false;
            referencedRelation: 'notes';
            referencedColumns: ['id'];
          }
        ];
      };
      reminders_attachments: {
        Row: {
          id: string;
          reminder_id: string;
          archive_chat_id: number;
          archive_message_id: number;
          kind: string;
          caption: string | null;
          file_unique_id: string | null;
          mime_type: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          reminder_id: string;
          archive_chat_id: number;
          archive_message_id: number;
          kind: string;
          caption?: string | null;
          file_unique_id?: string | null;
          mime_type?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          reminder_id?: string;
          archive_chat_id?: number;
          archive_message_id?: number;
          kind?: string;
          caption?: string | null;
          file_unique_id?: string | null;
          mime_type?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'reminders_attachments_reminder_id_fkey';
            columns: ['reminder_id'];
            isOneToOne: false;
            referencedRelation: 'reminders';
            referencedColumns: ['id'];
          }
        ];
      };
      daily_reports: {
        Row: {
          id: string;
          user_id: string;
          report_date: string;
          wake_time: string | null;
          routine_morning: boolean | null;
          routine_school: boolean | null;
          routine_taxi: boolean | null;
          routine_evening: boolean | null;
          routine_night: boolean | null;
          review_today_hours: number | null;
          preview_tomorrow_hours: number | null;
          homework_done: boolean | null;
          workout_morning: boolean | null;
          workout_evening: boolean | null;
          pomodoro_3_count: number | null;
          pomodoro_2_count: number | null;
          pomodoro_1_count: number | null;
          library_study_hours: number | null;
          exam_school_questions: number | null;
          exam_maz_questions: number | null;
          exam_hesaban_questions: number | null;
          exam_physics_questions: number | null;
          exam_chemistry_questions: number | null;
          exam_geology_questions: number | null;
          exam_language_questions: number | null;
          exam_religion_questions: number | null;
          exam_arabic_questions: number | null;
          exam_persian_questions: number | null;
          read_book_minutes: number | null;
          read_article_minutes: number | null;
          watch_video_minutes: number | null;
          course_minutes: number | null;
          english_conversation_minutes: number | null;
          skill_learning_minutes: number | null;
          telegram_bot_minutes: number | null;
          trading_strategy_minutes: number | null;
          tidy_study_area: boolean | null;
          clean_room: boolean | null;
          plan_tomorrow: boolean | null;
          family_time_minutes: number | null;
          sleep_time: string | null;
          notes: string | null;
          time_planned_study_minutes: number | null;
          time_planned_skills_minutes: number | null;
          time_planned_misc_minutes: number | null;
          streak_done: boolean | null;
          streak_days: number | null;
          xp_s: number | null;
          xp_study: number | null;
          xp_misc: number | null;
          xp_total: number | null;
          status: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          report_date: string;
          wake_time?: string | null;
          routine_morning?: boolean | null;
          routine_school?: boolean | null;
          routine_taxi?: boolean | null;
          routine_evening?: boolean | null;
          routine_night?: boolean | null;
          review_today_hours?: number | null;
          preview_tomorrow_hours?: number | null;
          homework_done?: boolean | null;
          workout_morning?: boolean | null;
          workout_evening?: boolean | null;
          pomodoro_3_count?: number | null;
          pomodoro_2_count?: number | null;
          pomodoro_1_count?: number | null;
          library_study_hours?: number | null;
          exam_school_questions?: number | null;
          exam_maz_questions?: number | null;
          exam_hesaban_questions?: number | null;
          exam_physics_questions?: number | null;
          exam_chemistry_questions?: number | null;
          exam_geology_questions?: number | null;
          exam_language_questions?: number | null;
          exam_religion_questions?: number | null;
          exam_arabic_questions?: number | null;
          exam_persian_questions?: number | null;
          read_book_minutes?: number | null;
          read_article_minutes?: number | null;
          watch_video_minutes?: number | null;
          course_minutes?: number | null;
          english_conversation_minutes?: number | null;
          skill_learning_minutes?: number | null;
          telegram_bot_minutes?: number | null;
          trading_strategy_minutes?: number | null;
          tidy_study_area?: boolean | null;
          clean_room?: boolean | null;
          plan_tomorrow?: boolean | null;
          family_time_minutes?: number | null;
          sleep_time?: string | null;
          notes?: string | null;
          time_planned_study_minutes?: number | null;
          time_planned_skills_minutes?: number | null;
          time_planned_misc_minutes?: number | null;
          streak_done?: boolean | null;
          streak_days?: number | null;
          xp_s?: number | null;
          xp_study?: number | null;
          xp_misc?: number | null;
          xp_total?: number | null;
          status?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          report_date?: string;
          wake_time?: string | null;
          routine_morning?: boolean | null;
          routine_school?: boolean | null;
          routine_taxi?: boolean | null;
          routine_evening?: boolean | null;
          routine_night?: boolean | null;
          review_today_hours?: number | null;
          preview_tomorrow_hours?: number | null;
          homework_done?: boolean | null;
          workout_morning?: boolean | null;
          workout_evening?: boolean | null;
          pomodoro_3_count?: number | null;
          pomodoro_2_count?: number | null;
          pomodoro_1_count?: number | null;
          library_study_hours?: number | null;
          exam_school_questions?: number | null;
          exam_maz_questions?: number | null;
          exam_hesaban_questions?: number | null;
          exam_physics_questions?: number | null;
          exam_chemistry_questions?: number | null;
          exam_geology_questions?: number | null;
          exam_language_questions?: number | null;
          exam_religion_questions?: number | null;
          exam_arabic_questions?: number | null;
          exam_persian_questions?: number | null;
          read_book_minutes?: number | null;
          read_article_minutes?: number | null;
          watch_video_minutes?: number | null;
          course_minutes?: number | null;
          english_conversation_minutes?: number | null;
          skill_learning_minutes?: number | null;
          telegram_bot_minutes?: number | null;
          trading_strategy_minutes?: number | null;
          tidy_study_area?: boolean | null;
          clean_room?: boolean | null;
          plan_tomorrow?: boolean | null;
          family_time_minutes?: number | null;
          sleep_time?: string | null;
          notes?: string | null;
          time_planned_study_minutes?: number | null;
          time_planned_skills_minutes?: number | null;
          time_planned_misc_minutes?: number | null;
          streak_done?: boolean | null;
          streak_days?: number | null;
          xp_s?: number | null;
          xp_study?: number | null;
          xp_misc?: number | null;
          xp_total?: number | null;
          status?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      rewards: {
        Row: {
          id: string;
          user_id: string | null;
          title: string;
          description: string | null;
          xp_cost: number;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          title: string;
          description?: string | null;
          xp_cost: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          title?: string;
          description?: string | null;
          xp_cost?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      reward_purchases: {
        Row: {
          id: string;
          user_id: string;
          reward_id: string;
          title_snapshot: string;
          cost_xp_snapshot: number;
          purchased_at_utc: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          reward_id: string;
          title_snapshot: string;
          cost_xp_snapshot: number;
          purchased_at_utc?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          reward_id?: string;
          title_snapshot?: string;
          cost_xp_snapshot?: number;
          purchased_at_utc?: string;
        };
        Relationships: [];
      };
      xp_ledger: {
        Row: {
          id: string;
          user_id: string;
          delta: number;
          reason: string;
          ref_type: string | null;
          ref_id: string | null;
          metadata_json: Record<string, unknown>;
          created_at_utc: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          delta: number;
          reason: string;
          ref_type?: string | null;
          ref_id?: string | null;
          metadata_json?: Record<string, unknown>;
          created_at_utc?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          delta?: number;
          reason?: string;
          ref_type?: string | null;
          ref_id?: string | null;
          metadata_json?: Record<string, unknown>;
          created_at_utc?: string;
        };
        Relationships: [];
      };
      callback_tokens: {
        Row: {
          token: string;
          user_id: string | null;
          payload_json: Record<string, unknown>;
          created_at: string;
          expires_at: string;
          used_at: string | null;
        };
        Insert: {
          token: string;
          user_id?: string | null;
          payload_json: Record<string, unknown>;
          created_at?: string;
          expires_at: string;
          used_at?: string | null;
        };
        Update: {
          token?: string;
          user_id?: string | null;
          payload_json?: Record<string, unknown>;
          created_at?: string;
          expires_at?: string;
          used_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'callback_tokens_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          }
        ];
      };
      user_settings: {
        Row: {
          id: string;
          user_id: string;
          onboarded: boolean;
          settings_json: Record<string, unknown> | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          onboarded?: boolean;
          settings_json?: Record<string, unknown> | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          onboarded?: boolean;
          settings_json?: Record<string, unknown> | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'user_settings_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          }
        ];
      };
      report_templates: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          title?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      report_items: {
        Row: {
          id: string;
          template_id: string;
          label: string;
          item_key: string;
          item_type: string;
          category: string | null;
          xp_mode: string | null;
          xp_value: number | null;
          xp_max_per_day: number | null;
          options_json: Record<string, unknown>;
          sort_order: number;
          enabled: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          template_id: string;
          label: string;
          item_key: string;
          item_type: string;
          category?: string | null;
          xp_mode?: string | null;
          xp_value?: number | null;
          xp_max_per_day?: number | null;
          options_json?: Record<string, unknown>;
          sort_order?: number;
          enabled?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          template_id?: string;
          label?: string;
          item_key?: string;
          item_type?: string;
          category?: string | null;
          xp_mode?: string | null;
          xp_value?: number | null;
          xp_max_per_day?: number | null;
          options_json?: Record<string, unknown>;
          sort_order?: number;
          enabled?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      report_days: {
        Row: {
          id: string;
          user_id: string;
          template_id: string;
          local_date: string;
          status: string | null;
          locked: boolean;
          created_at_utc: string;
          updated_at_utc: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          template_id: string;
          local_date: string;
          status?: string | null;
          locked?: boolean;
          created_at_utc?: string;
          updated_at_utc?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          template_id?: string;
          local_date?: string;
          status?: string | null;
          locked?: boolean;
          created_at_utc?: string;
          updated_at_utc?: string;
        };
        Relationships: [];
      };
      report_values: {
        Row: {
          id: string;
          report_day_id: string;
          item_id: string;
          value_json: Record<string, unknown> | null;
          xp_delta_applied: boolean;
          created_at_utc: string;
          updated_at_utc: string;
        };
        Insert: {
          id?: string;
          report_day_id: string;
          item_id: string;
          value_json?: Record<string, unknown> | null;
          xp_delta_applied?: boolean;
          created_at_utc?: string;
          updated_at_utc?: string;
        };
        Update: {
          id?: string;
          report_day_id?: string;
          item_id?: string;
          value_json?: Record<string, unknown> | null;
          xp_delta_applied?: boolean;
          created_at_utc?: string;
          updated_at_utc?: string;
        };
        Relationships: [];
      };
      routines: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          description: string | null;
          routine_type: string;
          xp_mode: 'none' | 'fixed' | 'per_minute' | 'per_number';
          xp_value: number | null;
          xp_max_per_day: number | null;
          is_active: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title: string;
          description?: string | null;
          routine_type: string;
          xp_mode?: 'none' | 'fixed' | 'per_minute' | 'per_number';
          xp_value?: number | null;
          xp_max_per_day?: number | null;
          is_active?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          title?: string;
          description?: string | null;
          routine_type?: string;
          xp_mode?: 'none' | 'fixed' | 'per_minute' | 'per_number';
          xp_value?: number | null;
          xp_max_per_day?: number | null;
          is_active?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      routine_tasks: {
        Row: {
          id: string;
          routine_id: string;
          title: string;
          description: string | null;
          item_type: 'boolean' | 'duration_minutes' | 'number';
          xp_mode: 'none' | 'fixed' | 'per_minute' | 'per_number';
          xp_value: number | null;
          xp_max_per_day: number | null;
          options_json: Record<string, unknown>;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          routine_id: string;
          title: string;
          description?: string | null;
          item_type: 'boolean' | 'duration_minutes' | 'number';
          xp_mode?: 'none' | 'fixed' | 'per_minute' | 'per_number';
          xp_value?: number | null;
          xp_max_per_day?: number | null;
          options_json?: Record<string, unknown>;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          routine_id?: string;
          title?: string;
          description?: string | null;
          item_type?: 'boolean' | 'duration_minutes' | 'number';
          xp_mode?: 'none' | 'fixed' | 'per_minute' | 'per_number';
          xp_value?: number | null;
          xp_max_per_day?: number | null;
          options_json?: Record<string, unknown>;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'routine_tasks_routine_id_fkey';
            columns: ['routine_id'];
            referencedRelation: 'routines';
            referencedColumns: ['id'];
          }
        ];
      };
      telemetry_events: {
        Row: {
          id: string;
          user_id: string;
          trace_id: string;
          event_name: string;
          screen: string | null;
          payload: Record<string, unknown> | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          trace_id: string;
          event_name: string;
          screen?: string | null;
          payload?: Record<string, unknown> | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          trace_id?: string;
          event_name?: string;
          screen?: string | null;
          payload?: Record<string, unknown> | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'telemetry_events_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          }
        ];
      };
      error_reports: {
        Row: {
          id: string;
          user_id: string;
          trace_id: string;
          error_code: string;
          error_json: Record<string, unknown>;
          recent_events: Record<string, unknown>;
          created_at: string;
        };
        Insert: {
          id: string;
          user_id: string;
          trace_id: string;
          error_code: string;
          error_json: Record<string, unknown>;
          recent_events: Record<string, unknown>;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          trace_id?: string;
          error_code?: string;
          error_json?: Record<string, unknown>;
          recent_events?: Record<string, unknown>;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'error_reports_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          }
        ];
      };
    };
    Views: {};
    Functions: {
      list_note_date_counts: {
        Args: {
          p_user_id: string;
          p_limit: number;
          p_offset: number;
        };
        Returns: {
          note_date: string;
          count: number;
        }[];
      };
    };
    Enums: {};
    CompositeTypes: {};
  };
};

export type ReminderRow = Database['public']['Tables']['reminders']['Row'];
export type NoteRow = Database['public']['Tables']['notes']['Row'];
export type NoteAttachmentRow = Database['public']['Tables']['note_attachments']['Row'];
export type ArchiveMessageRow = Database['public']['Tables']['archive_messages']['Row'];
export type RpcFunctionName = keyof Database['public']['Functions'];
export type DailyReportRow = Database['public']['Tables']['daily_reports']['Row'];
export type DailyReportInsert = Database['public']['Tables']['daily_reports']['Insert'];
export type DailyReportUpdate = Database['public']['Tables']['daily_reports']['Update'];
export type RewardRow = Database['public']['Tables']['rewards']['Row'];
export type RewardPurchaseRow = Database['public']['Tables']['reward_purchases']['Row'];
export type XpLedgerRow = Database['public']['Tables']['xp_ledger']['Row'];
export type RoutineRow = Database['public']['Tables']['routines']['Row'];
export type RoutineTaskRow = Database['public']['Tables']['routine_tasks']['Row'];
export type UserSettingsRow = Database['public']['Tables']['user_settings']['Row'];
export type CallbackTokenRow = Database['public']['Tables']['callback_tokens']['Row'];
export type ReportTemplateRow = Database['public']['Tables']['report_templates']['Row'];
export type ReportItemRow = Database['public']['Tables']['report_items']['Row'];
export type ReportDayRow = Database['public']['Tables']['report_days']['Row'];
export type ReportValueRow = Database['public']['Tables']['report_values']['Row'];
export type TelemetryEventRow = Database['public']['Tables']['telemetry_events']['Row'];
export type ErrorReportRow = Database['public']['Tables']['error_reports']['Row'];
