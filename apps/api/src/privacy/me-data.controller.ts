import { Controller, Delete, Get, Header, HttpCode, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthUser, ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { UserLimitGuard } from '../throttle/guards';
import { LIMITS, OPT_IN_WINDOWS, USER_WINDOWS } from '../throttle/limits';
import { DataDeletionService } from './data-deletion';
import { DataExportService } from './data-export';

// Export and delete my data. Every route acts on the caller's own user id from the
// verified session; nothing in the request names a user. All three are expensive or
// destructive, so each has a tight per-minute and per-hour limit of its own.
@Controller('me')
@UseGuards(ClerkAuthGuard, UserLimitGuard)
@SkipThrottle(OPT_IN_WINDOWS)
export class MeDataController {
  constructor(
    private readonly exporter: DataExportService,
    private readonly deletion: DataDeletionService,
  ) {}

  // GET /me/export: everything Larper holds about the caller, as a JSON download.
  @Get('export')
  @Header('Cache-Control', 'no-store')
  @SkipThrottle({ [USER_WINDOWS.hour]: false })
  @Throttle({
    [USER_WINDOWS.minute]: { limit: LIMITS.dataExport.minute },
    [USER_WINDOWS.hour]: { limit: LIMITS.dataExport.hour },
  })
  async export(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const now = new Date();
    res.setHeader('Content-Disposition', `attachment; filename="larper-export-${now.toISOString().slice(0, 10)}.json"`);
    return this.exporter.export(user.id, now);
  }

  // DELETE /me/history: journal, check-ins, hours answers and saved places. Keeps the
  // account and the taste profile. 403 for the shared demo account.
  @Delete('history')
  @HttpCode(200)
  @SkipThrottle({ [USER_WINDOWS.hour]: false })
  @Throttle({
    [USER_WINDOWS.minute]: { limit: LIMITS.dataDelete.minute },
    [USER_WINDOWS.hour]: { limit: LIMITS.dataDelete.hour },
  })
  deleteHistory(@CurrentUser() user: AuthUser) {
    return this.deletion.deleteHistory(user);
  }

  // DELETE /me: everything, including the account row (and the Clerk user when
  // CLERK_DELETE_USERS is on). 403 for the shared demo account.
  @Delete()
  @HttpCode(200)
  @SkipThrottle({ [USER_WINDOWS.hour]: false })
  @Throttle({
    [USER_WINDOWS.minute]: { limit: LIMITS.dataDelete.minute },
    [USER_WINDOWS.hour]: { limit: LIMITS.dataDelete.hour },
  })
  deleteAccount(@CurrentUser() user: AuthUser) {
    return this.deletion.deleteAccount(user);
  }
}
