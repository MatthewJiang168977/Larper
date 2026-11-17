import { QuestAction as EventAction } from '../gen/larper/events/v1/events_pb';
import { eventActionForReason, EVENT_ACTION, REASONS_THAT_COUNT_AS_DISLIKE } from './quests.service';
import { SKIP_REASONS, type SkipReason } from './transitions';

// "Not today" is never a dislike. taste-worker moves taste only for ACCEPTED, COMPLETED
// and SKIPPED events (workers/internal/taste), so the whole question is which actions and
// reasons the API turns into a SKIPPED event. Pinned here, per reason.
describe('what counts as a dislike', () => {
  it('the "Not today" action is a NOT_TODAY event, never SKIPPED', () => {
    expect(EVENT_ACTION['not-today']).toBe(EventAction.NOT_TODAY);
    expect(EVENT_ACTION['not-today']).not.toBe(EventAction.SKIPPED);
  });

  it('only a plain skip of an offer is SKIPPED among the actions', () => {
    const skipped = Object.entries(EVENT_ACTION).filter(([, a]) => a === EventAction.SKIPPED);
    expect(skipped).toEqual([['skip', EventAction.SKIPPED]]);
  });

  // The whole mapping, one row per reason. Adding a reason fails here until it has a row.
  const EXPECTED: Record<SkipReason, EventAction> = {
    not_my_thing: EventAction.SKIPPED, // an explicit dislike: the owner's call to keep or change
    too_far: EventAction.NOT_TODAY,
    not_today: EventAction.NOT_TODAY,
    closed: EventAction.NOT_TODAY,
  };

  it('has a row for every reason', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...SKIP_REASONS].sort());
  });

  it.each(SKIP_REASONS)('%s re-emits the event the table says', (reason) => {
    expect(eventActionForReason(reason)).toBe(EXPECTED[reason]);
  });

  it.each(['too_far', 'not_today', 'closed'] as const)('%s is never a SKIPPED event', (reason) => {
    expect(eventActionForReason(reason)).toBe(EventAction.NOT_TODAY);
    expect(REASONS_THAT_COUNT_AS_DISLIKE).not.toContain(reason);
  });

  it('the dislike list is one place, and is just "not my thing" for now', () => {
    expect([...REASONS_THAT_COUNT_AS_DISLIKE]).toEqual(['not_my_thing']);
  });
});
