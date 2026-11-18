import { createHash } from 'node:crypto';
import { Controller, Delete, ForbiddenException, Get, Header, HttpCode, Inject, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthUser, ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { UserLimitGuard } from '../throttle/guards';
import { LIMITS, OPT_IN_WINDOWS, USER_WINDOWS } from '../throttle/limits';
import { isDemoUser } from '../demo/demo-account';
import { DEMO_REFUSAL, DataDeletionService } from './data-deletion';
import { DataExportService } from './data-export';
import { PRIVACY_DELETES, deletesUnavailable, type PrivacyDeletes } from './privacy-deletes';

// Keep the existing hash namespace so DELETE /me keeps its counters. UserLimitGuard
// adds the route and window to the key for all three data routes.
const dataTracker = (req: { user?: AuthUser }) => {
  if (!req.user) throw new Error('data tracker must run after ClerkAuthGuard');
  return createHash('sha256').update('larper:delete-account\0').update(req.user.clerkId).digest('hex');
};

export const DEMO_EXPORT_REFUSAL = {
  statusCode: 403,
  code: 'demo_account',
  message: 'The demo account is shared by every visitor, so it has no data of its own to export. Sign up for your own account to download your data.',
};

// Export and delete my data. Every route acts on the caller's own user id from the
// verified session; nothing in the request names a user. All three are expensive or
// destructive, so each has a tight per-minute and per-hour limit of its own.
@Controller('me')
@UseGuards(ClerkAuthGuard, UserLimitGuard)
@SkipThrottle(OPT_IN_WINDOWS)
@Throttle({
  [USER_WINDOWS.minute]: { getTracker: dataTracker },
  [USER_WINDOWS.hour]: { getTracker: dataTracker },
})
export class MeDataController {
  constructor(
    private readonly exporter: DataExportService,
    private readonly deletion: DataDeletionService,
    @Inject(PRIVACY_DELETES) private readonly deletes: PrivacyDeletes,
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
    // The demo account is shared by every visitor: its journal (with each offer's
    // position, which can be a visitor's real location) is other people's data.
    if (isDemoUser(user.clerkId)) throw new ForbiddenException(DEMO_EXPORT_REFUSAL);
    const now = new Date();
    res.setHeader('Content-Disposition', `attachment; filename="larper-export-${now.toISOString().slice(0, 10)}.json"`);
    return this.exporter.export(user.id, now);
  }

  // DELETE /me/history: journal, check-ins, hours answers and saved places. Keeps the
  // account and the taste profile. 403 for the shared demo account; otherwise 503 until
  // PRIVACY_DELETES is history or all, before any delete query.
  @Delete('history')
  @HttpCode(200)
  @SkipThrottle({ [USER_WINDOWS.hour]: false })
  @Throttle({
    [USER_WINDOWS.minute]: { limit: LIMITS.dataDelete.minute },
    [USER_WINDOWS.hour]: { limit: LIMITS.dataDelete.hour },
  })
  deleteHistory(@CurrentUser() user: AuthUser) {
    // Demo first: the demo account gets its own refusal whatever the gate says.
    if (isDemoUser(user.clerkId)) throw new ForbiddenException(DEMO_REFUSAL);
    if (this.deletes === 'off') throw deletesUnavailable();
    return this.deletion.deleteHistory(user);
  }

  // DELETE /me: everything, including the account row, then the Clerk user (0005 D7). 403
  // for the shared demo account; otherwise 503 unless PRIVACY_DELETES=all.
  @Delete()
  @HttpCode(200)
  @SkipThrottle({ [USER_WINDOWS.hour]: false })
  @Throttle({
    [USER_WINDOWS.minute]: { limit: LIMITS.dataDelete.minute },
    [USER_WINDOWS.hour]: { limit: LIMITS.dataDelete.hour },
  })
  deleteAccount(@CurrentUser() user: AuthUser) {
    if (isDemoUser(user.clerkId)) throw new ForbiddenException(DEMO_REFUSAL);
    if (this.deletes !== 'all') throw deletesUnavailable();
    return this.deletion.deleteAccount(user);
  }
}
