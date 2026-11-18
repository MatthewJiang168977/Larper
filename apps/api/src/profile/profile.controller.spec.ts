import type { Pool } from 'pg';
import type { TagsService } from './tags.service';
import { ProfileController } from './profile.controller';

// GET /me: the account state, the demo flag and the privacy capability the web app reads.
describe('ProfileController GET /me', () => {
  const pg = { query: jest.fn() };
  const tags = { ready: jest.fn(), tagOf: [] as string[] };
  const make = (mode: 'off' | 'history') => new ProfileController(pg as unknown as Pool, tags as unknown as TagsService, mode);
  let before: string | undefined;

  beforeEach(() => {
    pg.query.mockReset().mockResolvedValue({ rows: [] });
    before = process.env.DEMO_CLERK_USER_ID;
    process.env.DEMO_CLERK_USER_ID = 'user_demo9';
  });
  afterEach(() => {
    if (before === undefined) delete process.env.DEMO_CLERK_USER_ID;
    else process.env.DEMO_CLERK_USER_ID = before;
  });

  it('reports export on and deletes off by default', async () => {
    expect(await make('off').me({ id: 'u1', clerkId: 'user_a' })).toEqual({
      id: 'u1',
      onboarded: false,
      topTags: [],
      demo: false,
      privacy: { export: true, deleteHistory: false, deleteAccount: false },
    });
  });

  it('reports deleteHistory with PRIVACY_DELETES=history, and never deleteAccount', async () => {
    const me = await make('history').me({ id: 'u1', clerkId: 'user_a' });
    expect(me.privacy).toEqual({ export: true, deleteHistory: true, deleteAccount: false });
  });

  it('reports all false for the demo account, whatever the flag', async () => {
    const me = await make('history').me({ id: 'u2', clerkId: 'user_demo9' });
    expect(me).toMatchObject({ demo: true, privacy: { export: false, deleteHistory: false, deleteAccount: false } });
  });

  it('includes privacy for an onboarded account too', async () => {
    pg.query.mockResolvedValue({ rows: [{ vec: '[]' }] });
    const me = await make('history').me({ id: 'u1', clerkId: 'user_a' });
    expect(me).toMatchObject({ onboarded: true, privacy: { export: true, deleteHistory: true, deleteAccount: false } });
  });
});
