import { Controller, Get, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthUser, ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { UserLimitGuard } from '../throttle/guards';
import { OPT_IN_WINDOWS } from '../throttle/limits';
import { QuestsService } from './quests.service';

// The "want to go" list: places the caller accepted a quest at (migration 0017). Written
// by accepting a quest (QuestsService.act); this only reads. Under the default per-user
// limit, like the journal.
@Controller('saved-places')
@UseGuards(ClerkAuthGuard, UserLimitGuard)
@SkipThrottle(OPT_IN_WINDOWS)
export class SavedPlacesController {
  constructor(private readonly quests: QuestsService) {}

  // GET /saved-places: newest first, at most 100.
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.quests.savedPlaces(user.id);
  }
}
