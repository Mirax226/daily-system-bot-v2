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
    };
    Views: {};
    Functions: {};
    Enums: {};
    CompositeTypes: {};
  };
};
