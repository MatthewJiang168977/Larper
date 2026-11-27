import { CanActivate, ExecutionContext, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser, ClerkAuthGuard } from '../auth/auth.guard';
import { isDemoUser } from '../demo/demo-account';

// Who may use /admin/*: ADMIN_USER_IDS, comma-separated, each a Larper user id (the data
// export's account.id) or a Clerk user id (user_...). Everyone else, signed out included,
// gets the same 404 as a route that doesn't exist.

export function adminIds(raw = process.env.ADMIN_USER_IDS): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isAdmin(user: AuthUser, env: NodeJS.ProcessEnv = process.env): boolean {
  const ids = adminIds(env.ADMIN_USER_IDS);
  // The shared demo account is never an admin: anyone can sign in as it.
  return !isDemoUser(user.clerkId, env) && (ids.has(user.id) || ids.has(user.clerkId));
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: ClerkAuthGuard) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const missing = () => new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    if (!adminIds().size) throw missing();
    try {
      await this.auth.canActivate(ctx);
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() < 500) throw missing();
      throw err;
    }
    if (!req.user || !isAdmin(req.user)) throw missing();
    return true;
  }
}
