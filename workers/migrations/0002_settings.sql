-- settings テーブル: テーマや将来のクラウド同期設定を保存する
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'light');
