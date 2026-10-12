-- Transactional outbox: the API writes an event row in the same transaction as the
-- state change it describes, and outbox-relay publishes it to Kafka afterwards.
-- No dual write, so a crash can never leave the DB and the event log disagreeing.
CREATE TABLE outbox (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic      text        NOT NULL,
  key        text        NOT NULL,     -- Kafka record key (user id: per-user ordering)
  type       text        NOT NULL,     -- protobuf message name, sent as a record header
  payload    bytea       NOT NULL,     -- serialized protobuf
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
-- The relay only ever scans unsent rows, oldest first.
CREATE INDEX outbox_unsent ON outbox (id) WHERE sent_at IS NULL;

-- Consumer-side dedupe. Delivery is at-least-once (the relay can crash between
-- publishing and marking a row sent), so each consumer records the event ids it has
-- applied, in the same transaction as the effect.
CREATE TABLE processed_events (
  consumer     text        NOT NULL,
  event_id     uuid        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
