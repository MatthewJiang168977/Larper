import { Module } from '@nestjs/common';
import { ClerkAuthGuard } from './auth.guard';
import { clerkVerifier } from './clerk-verifier';
import { SESSION_VERIFIER } from './session-verifier';
import { UsersService } from './users.service';

@Module({
  providers: [
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
