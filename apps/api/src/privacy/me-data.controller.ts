import { createHash } from 'node:crypto';
import { Controller, Delete, ForbiddenException, Get, Header, HttpCode, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthUser, ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { UserLimitGuard } from '../throttle/guards';
import { LIMITS, OPT_IN_WINDOWS, USER_WINDOWS } from '../throttle/limits';
import { isDemoUser } from '../demo/demo-account';
import { DataDeletionService } from './data-deletion';
import { DataExportService } from './data-export';

// The guard has already verified the Clerk subject. Deleting and recreating the
// Larper row must not reset either rate-limit window.
const accountDeleteTracker = (req: { user?: AuthUser }) => {
  if (!req.user) throw new Error('account delete tracker must run after ClerkAuthGuard');
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
    // The demo account is shared by every visitor: its journal (with each offer's
    // position, which can be a visitor's real location) is other people's data.
    if (isDemoUser(user.clerkId)) throw new ForbiddenException(DEMO_EXPORT_REFUSAL);
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
    [USER_WINDOWS.minute]: { limit: LIMITS.dataDelete.minute, getTracker: accountDeleteTracker },
    [USER_WINDOWS.hour]: { limit: LIMITS.dataDelete.hour, getTracker: accountDeleteTracker },
  })
  deleteAccount(@CurrentUser() user: AuthUser) {
    return this.deletion.deleteAccount(user);
  }
}
