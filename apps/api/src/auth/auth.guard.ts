import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SESSION_VERIFIER, type SessionVerifier } from './session-verifier';
import { UsersService } from './users.service';

export interface AuthUser {
  id: string; // our users.id
  clerkId: string;
}

type AuthedRequest = Request & { user?: AuthUser };

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private readonly log = new Logger(ClerkAuthGuard.name);

  constructor(
    @Inject(SESSION_VERIFIER) private readonly verify: SessionVerifier,
    private readonly users: UsersService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();

    let clerkId: string;
    try {
      ({ clerkId } = await this.verify(header.slice('Bearer '.length)));
    } catch (err) {
      this.log.debug(`rejected token: ${(err as Error).message}`);
      throw new UnauthorizedException();
    }
    req.user = { clerkId, id: await this.users.ensure(clerkId) };
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().user!,
);
