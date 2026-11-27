import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { AuthUser, CurrentUser } from '../auth/auth.guard';
import { UserLimitGuard } from '../throttle/guards';
import { LIMITS, OPT_IN_WINDOWS, USER_WINDOWS } from '../throttle/limits';
import { AdminGuard } from './admin.guard';
import { CurationService } from './curation.service';

// The curation page's API. AdminGuard runs first, so anyone else gets a 404 and never a
// 401 or 429 that would say the route exists.
@Controller('admin/places')
@UseGuards(AdminGuard, UserLimitGuard)
@SkipThrottle(OPT_IN_WINDOWS)
@Throttle({ [USER_WINDOWS.minute]: { limit: LIMITS.curation.minute } })
export class CurationController {
  constructor(private readonly curation: CurationService) {}

  // GET /admin/places?area=east-village
  @Get()
  list(@Query('area') area = 'east-village') {
    return this.curation.list(String(area));
  }

  // POST /admin/places/:id/facts { kind, note?, hours? }
  @Post(':id/facts')
  @HttpCode(200)
  record(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { kind?: unknown; note?: unknown; hours?: unknown } = {},
  ) {
    if (!/^[1-9]\d{0,17}$/.test(id)) throw new BadRequestException('bad place id');
    return this.curation.record(user.id, id, body ?? {});
  }
}
