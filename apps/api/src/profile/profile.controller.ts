import { BadRequestException, Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Pool } from 'pg';
import { AuthUser, ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { PG } from '../db/db.module';
import { UserLimitGuard } from '../throttle/guards';
import { LIMITS, OPT_IN_WINDOWS, USER_WINDOWS } from '../throttle/limits';
import { VIBE_CARDS } from './cards';
import { TAG_DIMS, TagsService } from './tags.service';
import { seedTasteVector, topTags, toVectorLiteral } from './taste';

interface OnboardingBody {
  liked?: unknown;
  passed?: unknown;
}

const cardsById = new Map(VIBE_CARDS.map((c) => [c.id, c]));

@Controller()
@UseGuards(ClerkAuthGuard, UserLimitGuard)
@SkipThrottle(OPT_IN_WINDOWS)
export class ProfileController {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    private readonly tags: TagsService,
  ) {}

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const { rows } = await this.pg.query<{ vec: string }>(
      'SELECT vec::text AS vec FROM taste_profiles WHERE user_id = $1',
      [user.id],
    );
    if (!rows.length) return { id: user.id, onboarded: false, topTags: [] };
    await this.tags.ready();
    return { id: user.id, onboarded: true, topTags: topTags(JSON.parse(rows[0].vec), this.tags.tagOf) };
  }

  @Get('onboarding/cards')
  cards() {
    return VIBE_CARDS.map(({ id, title, blurb }) => ({ id, title, blurb }));
  }

  // Seeds (or re-seeds) the taste profile from one pass through the cards.
  @Post('onboarding')
  @Throttle({ [USER_WINDOWS.minute]: { limit: LIMITS.onboarding.minute } })
  async onboard(@CurrentUser() user: AuthUser, @Body() body: OnboardingBody) {
    const liked = parseCardIds(body.liked, 'liked');
    const passed = parseCardIds(body.passed, 'passed');
    if (liked.some((c) => passed.includes(c))) throw new BadRequestException('a card cannot be both liked and passed');

    await this.tags.ready();
    const vec = seedTasteVector(liked, passed, this.tags.slotOf, TAG_DIMS);
    if (!vec) throw new BadRequestException('like at least one card');

    await this.pg.query(
      `INSERT INTO taste_profiles (user_id, vec, source) VALUES ($1, $2::vector, 'onboarding')
       ON CONFLICT (user_id) DO UPDATE SET vec = EXCLUDED.vec, source = EXCLUDED.source, updated_at = now()`,
      [user.id, toVectorLiteral(vec)],
    );
    return { onboarded: true, topTags: topTags(vec, this.tags.tagOf) };
  }
}

function parseCardIds(value: unknown, field: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > VIBE_CARDS.length) {
    throw new BadRequestException(`${field} must be an array of card ids`);
  }
  return [...new Set(value)].map((id) => {
    const card = typeof id === 'string' ? cardsById.get(id) : undefined;
    if (!card) throw new BadRequestException(`unknown card ${String(id)} in ${field}`);
    return card;
  });
}
