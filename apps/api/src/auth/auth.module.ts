import { Module } from '@nestjs/common';
import { ClerkAuthGuard } from './auth.guard';
import { CLERK_USER_CHECK, clerkUserCheckFromEnv } from './clerk-user-check';
import { clerkVerifier } from './clerk-verifier';
import { SESSION_VERIFIER } from './session-verifier';
import { UsersService } from './users.service';

@Module({
  providers: [
    // Null unless PRIVACY_DELETES=all: then a new account needs a Clerk user that still exists.
    { provide: CLERK_USER_CHECK, useFactory: () => clerkUserCheckFromEnv(process.env) },
    UsersService,
    ClerkAuthGuard,
    {
      provide: SESSION_VERIFIER,
      useFactory: () =>
        clerkVerifier(
          process.env.CLERK_PUBLISHABLE_KEY ?? '',
          (process.env.CLERK_AUTHORIZED_PARTIES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        ),
    },
  ],
  exports: [ClerkAuthGuard, UsersService, SESSION_VERIFIER],
})
export class AuthModule {}
