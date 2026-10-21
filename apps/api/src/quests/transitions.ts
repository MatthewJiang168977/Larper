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

export const isSkipReason = (s: unknown): s is SkipReason =>
  typeof s === 'string' && (SKIP_REASONS as readonly string[]).includes(s);
