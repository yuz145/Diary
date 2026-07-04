ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_notes_pinned_date ON notes(pinned DESC, date DESC);
