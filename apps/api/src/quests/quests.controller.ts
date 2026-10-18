import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { AuthUser, ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { UserLimitGuard, userKey } from '../throttle/guards';
import { actionOf, isCheckIn, LIMITS, OPT_IN_WINDOWS, USER_WINDOWS } from '../throttle/limits';
import { QuestsService } from './quests.service';
import { isAction } from './transitions';

const DEFAULT_RADIUS_M = 1500;
const MIN_RADIUS_M = 300;
const MAX_RADIUS_M = 3000;

// Accept, skip and check-in share a handler but not their counters: each action has its own.
const byAction = (ctx: Parameters<typeof actionOf>[0], userId: string, name: string) =>
  userKey(ctx, userId, name, actionOf(ctx));

@Controller('quests')
@UseGuards(ClerkAuthGuard, UserLimitGuard)
@SkipThrottle(OPT_IN_WINDOWS)
export class QuestsController {
  constructor(private readonly quests: QuestsService) {}

  // GET /quests/today?lat=40.7295&lng=-73.9965[&radius=1500]
  // The survey poll calls this every 4 s while an area is being ingested.
  @Get('today')
  @SkipThrottle({ [USER_WINDOWS.tenSeconds]: false })
  @Throttle({
    [USER_WINDOWS.minute]: { limit: LIMITS.questsToday.minute },
    [USER_WINDOWS.tenSeconds]: { limit: LIMITS.questsToday.tenSeconds },
  })
  today(
    @CurrentUser() user: AuthUser,
    @Query('lat') latQ: string,
    @Query('lng') lngQ: string,
    @Query('radius') radiusQ?: string,
  ) {
    const lat = Number(latQ);
    const lng = Number(lngQ);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) {
      throw new BadRequestException('lat and lng are required');
    }
    const radius = radiusQ === undefined ? DEFAULT_RADIUS_M : Number(radiusQ);
    if (!Number.isFinite(radius)) throw new BadRequestException('radius must be a number');
    // Rounded to 100 m so the cache key space stays small.
    const radiusM = Math.round(Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, radius)) / 100) * 100;
    return this.quests.today(user.id, lat, lng, radiusM);
  }

  @Get()
  log(@CurrentUser() user: AuthUser) {
    return this.quests.log(user.id);
  }

  // POST /quests/:id/accept | skip | complete
  // Body for complete: { lat, lng, accuracy? } (the geofenced check-in).
  @Post(':id/:action')
  @SkipThrottle({ [USER_WINDOWS.hour]: false })
  @Throttle({
    [USER_WINDOWS.minute]: {
      limit: (ctx) => (isCheckIn(ctx) ? LIMITS.checkIn.minute : LIMITS.questAction.minute),
      generateKey: byAction,
    },
    [USER_WINDOWS.hour]: {
      limit: (ctx) => (isCheckIn(ctx) ? LIMITS.checkIn.hour : LIMITS.questAction.hour),
      generateKey: byAction,
    },
  })
  act(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: { lat?: unknown; lng?: unknown; accuracy?: unknown } = {},
  ) {
    if (!/^\d+$/.test(id)) throw new BadRequestException('bad quest id');
    if (!isAction(action)) throw new BadRequestException('action must be accept, skip, or complete');
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    const accuracy = Number(body?.accuracy);
    const at =
      Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
        ? { lat, lng, accuracyM: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : undefined }
        : undefined;
    return this.quests.act(user.id, id, action, at);
  }
}
