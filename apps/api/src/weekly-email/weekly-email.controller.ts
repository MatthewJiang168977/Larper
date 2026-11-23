import { Body, Controller, Get, Header, HttpCode, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard, CurrentUser, type AuthUser } from '../auth/auth.guard';
import { WeeklyEmailService } from './weekly-email.service';

const html = (contents: string) => `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Larper weekly email</title>
<main style="font:16px system-ui,sans-serif;background:#f9efe4;color:#000;border:1px solid;padding:16px;max-width:32rem;margin:24px auto">
<h1>larper weekly email</h1>${contents}</main></html>`;

@Controller('me/weekly-email')
@UseGuards(ClerkAuthGuard)
export class WeeklyEmailPreferenceController {
  constructor(private readonly email: WeeklyEmailService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@CurrentUser() user: AuthUser) { return this.email.preference(user); }

  @Put()
  set(@CurrentUser() user: AuthUser, @Body('enabled') enabled: unknown) {
    return this.email.setPreference(user, enabled);
  }
}

@Controller('weekly-email/unsubscribe')
export class WeeklyEmailUnsubscribeController {
  constructor(private readonly email: WeeklyEmailService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('Content-Type', 'text/html; charset=utf-8')
  confirm(@Query('token') token: unknown) {
    this.email.checkUnsubscribe(token);
    // Same-URL POST retains the token query parameter. Prefetchers only read this page.
    return html('<form method="post"><p>Stop receiving Larper’s weekly quest email.</p><button style="min-height:44px;padding:0 16px">unsubscribe</button></form>');
  }

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async unsubscribe(@Query('token') token: unknown) {
    await this.email.unsubscribe(token);
    return html('<p>You’ve unsubscribed from Larper’s weekly quest email.</p>');
  }
}
