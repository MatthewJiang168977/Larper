export type QuestStatus = 'offered' | 'accepted' | 'completed' | 'skipped' | 'expired';
export type QuestAction = 'accept' | 'skip' | 'complete';

// Allowed moves. The UPDATE in QuestsService uses `from` as its WHERE clause, so a
// stale double-click or two tabs racing can't, say, complete a skipped quest.
export const TRANSITIONS: Record<QuestAction, { from: QuestStatus[]; to: QuestStatus }> = {
  accept: { from: ['offered'], to: 'accepted' },
  skip: { from: ['offered', 'accepted'], to: 'skipped' },
  // Completing is a geofenced check-in (checkin.ts).
  complete: { from: ['accepted'], to: 'completed' },
};

export const isAction = (s: string): s is QuestAction => s in TRANSITIONS;
