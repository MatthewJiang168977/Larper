import { Module } from '@nestjs/common';
import { ThrottleModule } from '../throttle/throttle.module';
import { clerkApi } from './clerk-api';
import { demoConfig } from './demo-account';
import { DEMO, DemoController, type Demo } from './demo.controller';

// On when DEMO_CLERK_USER_ID is set (Helm demo.enabled), which also needs
// CLERK_SECRET_KEY: read once, so a bad setting fails the API at startup.
@Module({
  imports: [ThrottleModule],
  controllers: [DemoController],
  providers: [
    {
      provide: DEMO,
      useFactory: (): Demo => {
        const cfg = demoConfig(process.env);
        if (!cfg) return null;
        const key = process.env.CLERK_SECRET_KEY?.trim();
        if (!key) throw new Error('DEMO_CLERK_USER_ID is set but CLERK_SECRET_KEY is not');
        return { clerk: clerkApi(key), cfg };
      },
    },
  ],
})
export class DemoModule {}
