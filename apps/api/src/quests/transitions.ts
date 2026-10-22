export type QuestStatus = 'offered' | 'accepted' | 'completed' | 'skipped' | 'expired';
export type QuestAction = 'accept' | 'skip' | 'not-today' | 'complete';

// Allowed moves. The UPDATE in QuestsService uses `from` as its WHERE clause, so a
// stale double-click or two tabs racing can't, say, complete a skipped quest.
export const TRANSITIONS: Record<QuestAction, { from: QuestStatus[]; to: QuestStatus }> = {
  accept: { from: ['offered'], to: 'accepted' },
  skip: { from: ['offered', 'accepted'], to: 'skipped' },
  // "Not today": skipped too, but neutral for taste until the user says why.
  'not-today': { from: ['accepted'], to: 'skipped' },
  // Completing is a geofenced check-in (checkin.ts).
  complete: { from: ['accepted'], to: 'completed' },
};

export const isAction = (s: string): s is QuestAction => Object.hasOwn(TRANSITIONS, s);

// What the user can say after "Not today". Only 'not_my_thing' moves taste.
export const SKIP_REASONS = ['not_my_thing', 'too_far', 'not_today', 'closed'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

// How long a place stays out of the deck after a quest there ended, by how it ended
// (quests.service recentlyDone). The one place these windows live.
// - skip: a plain Skip of an offer (skip_reason NULL)
// - unstated: "Not today" with no reason given
export type ReofferKey = 'completed' | 'skip' | 'unstated' | SkipReason;
export const REOFFER_AFTER_DAYS: Record<ReofferKey, number> = {
  completed: 30,
  skip: 30,
  not_my_thing: 30,
  too_far: 7,
  closed: 3,
  not_today: 1,
  unstated: 1,
};

export const isSkipReason = (s: unknown): s is SkipReason =>
  typeof s === 'string' && (SKIP_REASONS as readonly string[]).includes(s);
