import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate, timestampNow } from '@bufbuild/protobuf/wkt';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { PlaceReportKind, PlaceReportSchema, QuestAction, QuestEventSchema, SkipReason } from '../gen/larper/events/v1/events_pb';

export const USER_EVENTS_TOPIC = 'user.events';

export interface QuestEventInput {
  userId: string;
  questId: string;
  placeId: string;
  action: QuestAction;
  skipReason?: SkipReason;
}

// Writes a QuestEvent to the outbox using the caller's transaction client. It only
// becomes visible to outbox-relay if that transaction commits, which is the point:
// the event exists if and only if the state change does.
export async function enqueueQuestEvent(tx: Pick<PoolClient, 'query'>, e: QuestEventInput): Promise<string> {
  const eventId = randomUUID();
  const msg = create(QuestEventSchema, { ...e, eventId, occurredAt: timestampNow() });
  await tx.query('INSERT INTO outbox (topic, key, type, payload) VALUES ($1, $2, $3, $4)', [
    USER_EVENTS_TOPIC,
    e.userId,
    QuestEventSchema.typeName,
    Buffer.from(toBinary(QuestEventSchema, msg)),
  ]);
  return eventId;
}

export type PlaceReportInput =
  // A person's report, about one of their quests.
  | { placeId: string; userId: string; questId: string; at?: Date; kind: PlaceReportKind }
  // The curator's verdict: a fact about the place, with no user on it.
  | { placeId: string; userId?: undefined; questId?: undefined; at?: Date; kind: PlaceReportKind };

// A PlaceReport for the reliability-worker, in the caller's transaction like QuestEvent.
// Keyed by the user id, so "delete my history" removes unsent ones with their other events;
// the curator's are keyed by the place, so clearing their own history never drops a verdict.
export async function enqueuePlaceReport(tx: Pick<PoolClient, 'query'>, r: PlaceReportInput): Promise<string> {
  const eventId = randomUUID();
  const { at, ...fields } = r;
  const msg = create(PlaceReportSchema, { ...fields, eventId, occurredAt: at ? timestampFromDate(at) : timestampNow() });
  await tx.query('INSERT INTO outbox (topic, key, type, payload) VALUES ($1, $2, $3, $4)', [
    USER_EVENTS_TOPIC,
    r.userId ?? `place:${r.placeId}`,
    PlaceReportSchema.typeName,
    Buffer.from(toBinary(PlaceReportSchema, msg)),
  ]);
  return eventId;
}
