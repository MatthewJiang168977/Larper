import { create, toBinary } from '@bufbuild/protobuf';
import { timestampNow } from '@bufbuild/protobuf/wkt';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { QuestAction, QuestEventSchema } from '../gen/larper/events/v1/events_pb';

export const USER_EVENTS_TOPIC = 'user.events';

export interface QuestEventInput {
  userId: string;
  questId: string;
  placeId: string;
  action: QuestAction;
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
