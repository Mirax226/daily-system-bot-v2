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
      reminders: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          detail: string | null;
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
          next_run_at_utc?: string | null;
          last_sent_at_utc?: string | null;
          enabled?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {};
    Functions: {};
    Enums: {};
    CompositeTypes: {};
  };
};

export type ReminderRow = Database['public']['Tables']['reminders']['Row'];
