-- notes テーブル: 本文・メタデータをすべてD1に持たせる
-- 画像はR2に保存し、image_keysにR2オブジェクトキーの配列(JSON文字列)を持たせる

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  title TEXT,                -- NULL可。未入力を許容する
  content TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,        -- 作成日時 ISO8601
  updated_at TEXT NOT NULL,  -- 更新日時 ISO8601
  tags TEXT,                 -- カンマ区切り文字列。例: "daily,memo"
  image_keys TEXT            -- R2オブジェクトキーのJSON配列文字列。例: '["images/xxx.jpg"]'
);

CREATE INDEX idx_notes_date ON notes(date DESC);
