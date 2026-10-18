CREATE TABLE IF NOT EXISTS rate_limits (
  user_id TEXT NOT NULL REFERENCES users(id),
  window TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(user_id, window)
);
CREATE INDEX IF NOT EXISTS rate_limits_window ON rate_limits(window);

CREATE TRIGGER IF NOT EXISTS tasks_limit_per_user
BEFORE INSERT ON tasks
WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.id)
  AND (SELECT COUNT(*) FROM tasks WHERE user_id = NEW.user_id) >= 5000
BEGIN
  SELECT RAISE(ABORT, 'task limit exceeded');
END;
