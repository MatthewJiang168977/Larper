CREATE TABLE weekly_email_preferences (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  opted_in_at timestamptz,
  email_address_id text,
  unsubscribe_id uuid UNIQUE,
  last_attempt_day date,
  CHECK (
    (opted_in_at IS NULL AND email_address_id IS NULL AND unsubscribe_id IS NULL) OR
    (opted_in_at IS NOT NULL AND email_address_id IS NOT NULL AND unsubscribe_id IS NOT NULL)
  )
);

GRANT SELECT, INSERT, UPDATE ON weekly_email_preferences TO larper_api;
