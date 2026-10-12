import { fromBinary } from '@bufbuild/protobuf';
import { QuestAction, QuestEventSchema } from '../gen/larper/events/v1/events_pb';
import { enqueueQuestEvent, USER_EVENTS_TOPIC } from './outbox';

describe('enqueueQuestEvent', () => {
  it('writes a keyed, typed, decodable protobuf row', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const id = await enqueueQuestEvent({ query } as never, {
      userId: '7',
      questId: '42',
      placeId: '9001',
      action: QuestAction.COMPLETED,
    });

    const [, params] = query.mock.calls[0] as unknown as [string, [string, string, string, Buffer]];
    const [topic, key, type, payload] = params;
    expect(topic).toBe(USER_EVENTS_TOPIC);
    expect(key).toBe('7'); // partition key: per-user ordering
    expect(type).toBe('larper.events.v1.QuestEvent');

    const evt = fromBinary(QuestEventSchema, payload);
    expect(evt).toMatchObject({ eventId: id, userId: '7', questId: '42', placeId: '9001', action: QuestAction.COMPLETED });
    expect(evt.occurredAt?.seconds).toBeGreaterThan(0n);
  });

  it('gives every event a fresh id', async () => {
    const tx = { query: jest.fn(async () => ({ rows: [] })) };
    const input = { userId: '1', questId: '1', placeId: '1', action: QuestAction.SKIPPED };
    expect(await enqueueQuestEvent(tx as never, input)).not.toBe(await enqueueQuestEvent(tx as never, input));
  });
});
