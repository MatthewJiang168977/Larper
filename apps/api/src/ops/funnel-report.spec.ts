import { excludedIds, funnel, FunnelQuest, render, weekOf } from './funnel-report';

const NOW = new Date('2026-11-26T17:00:00Z'); // Thursday
const at = (s: string) => new Date(`${s}T17:00:00Z`);
const quest = (userId: string, offered: string, over: Partial<FunnelQuest> = {}): FunnelQuest => ({
  userId,
  offeredAt: at(offered),
  acceptedAt: null,
  completedAt: null,
  worthIt: null,
  wasOpen: null,
  ...over,
});

describe('funnel report', () => {
  it('weeks start on Monday, New York time', () => {
    expect(weekOf(at('2026-11-26'))).toBe('2026-11-23');
    expect(weekOf(new Date('2026-11-23T04:59:00Z'))).toBe('2026-11-16'); // Sunday evening in New York
  });

  it('counts the funnel, wasted walks and weekly return', () => {
    const quests = [
      quest('1', '2026-11-03', { acceptedAt: at('2026-11-03'), completedAt: at('2026-11-04'), wasOpen: true, worthIt: 'yes' }),
      quest('1', '2026-11-10', { acceptedAt: at('2026-11-10') }),
      quest('2', '2026-11-03', { acceptedAt: at('2026-11-03'), completedAt: at('2026-11-12'), wasOpen: false }),
      quest('3', '2026-11-04'),
      quest('3', '2026-11-24', { acceptedAt: at('2026-11-24') }),
      quest('4', '2026-09-01', { acceptedAt: at('2026-09-01') }), // outside the window
    ];
    const f = funnel(quests, NOW, 28);
    expect(f).toMatchObject({
      people: 3,
      offered: 5,
      accepted: 4,
      checkedIn: 2,
      peopleCheckedIn: 2,
      checkedInWithin7Days: 1,
      worthIt: { yes: 1, meh: 0, no: 0 },
      wasOpenAnswered: 2,
      wastedWalks: 1,
    });
    // The week of 11-16 has no week after it that is over, so it is not reported.
    expect(f.weeklyReturn).toEqual([
      { week: '2026-08-31', active: 1, returned: 0 },
      { week: '2026-11-02', active: 2, returned: 2 },
      { week: '2026-11-09', active: 2, returned: 0 },
    ]);
    expect(render(f, 28, 2).join('\n')).toContain('wasted walks (wasn\'t open / check-ins)   1 of 2 (50%)');
  });

  it('leaves out admins, the demo account and extra ids', () => {
    expect(excludedIds({ ADMIN_USER_IDS: '1, user_a', DEMO_CLERK_USER_ID: 'user_demo' }, '7')).toEqual(['1', 'user_a', 'user_demo', '7']);
  });
});
