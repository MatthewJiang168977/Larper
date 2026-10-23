import {
  Controller,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { DemoLimitGuard } from '../throttle/guards';
import type { ClerkApi } from './clerk-api';
import { demoSignInToken, type DemoConfig } from './demo-account';

export const DEMO = Symbol('DEMO');
/** The demo account and a Clerk client for it, or null when the demo is off. */
export type Demo = { clerk: ClerkApi; cfg: DemoConfig } | null;

// POST /demo/sign-in -> { ticket }: a one-time Clerk sign-in token for the shared demo
// account (demo/demo-account.ts), which the web app redeems with signIn.ticket(). No
// auth: it's how a visitor gets one. Only ever for the configured demo user (the
// request has no body to name another), short-lived, and rate-limited per IP and for
// everyone together (DemoLimitGuard). 404 where the demo is off.
@Controller('demo')
export class DemoController {
  private readonly log = new Logger('Demo');

  constructor(@Inject(DEMO) private readonly demo: Demo) {}

  @Post('sign-in')
  @HttpCode(200)
  @UseGuards(DemoLimitGuard)
  async signIn(): Promise<{ ticket: string }> {
    if (!this.demo) throw new NotFoundException();
    try {
      const { token, repaired } = await demoSignInToken(this.demo.clerk, this.demo.cfg);
      if (repaired.length) this.log.warn(`demo account: took off ${repaired.join(' and ')} before signing in`);
      return { ticket: token };
    } catch (err) {
      this.log.error(`demo sign-in token failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('The demo is unavailable right now.');
    }
  }
}
