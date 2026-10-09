-- Explicit public presentation, never inferred from private provider routes.
-- Existing aliases retain their original public shape until an admin opts in.
ALTER TABLE aliases ADD COLUMN display_name TEXT
  CHECK (display_name IS NULL OR length(trim(display_name)) BETWEEN 1 AND 120);
ALTER TABLE aliases ADD COLUMN provider TEXT
  CHECK (provider IS NULL OR provider IN ('openai', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'opencode-go', 'opencode-zen'));
ALTER TABLE aliases ADD COLUMN tier TEXT
  CHECK (tier IS NULL OR tier IN ('economy', 'balanced', 'premium'));
