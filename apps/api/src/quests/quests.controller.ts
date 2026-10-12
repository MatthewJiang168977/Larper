import { BadRequestException, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { QuestsService } from './quests.service';
import { isAction } from './transitions';

const DEFAULT_RADIUS_M = 1500;
const MIN_RADIUS_M = 300;
const MAX_RADIUS_M = 3000;

@Controller('quests')
@UseGuards(ClerkAuthGuard)
export class QuestsController {
  constructor(private readonly quests: QuestsService) {}

  // GET /quests/today?lat=40.7295&lng=-73.9965[&radius=1500]
  @Get('today')
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
  @Post(':id/:action')
  act(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('action') action: string) {
    if (!/^\d+$/.test(id)) throw new BadRequestException('bad quest id');
    if (!isAction(action)) throw new BadRequestException('action must be accept, skip, or complete');
    return this.quests.act(user.id, id, action);
  }
}
