import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

// Liveness/readiness probes for Kubernetes, and the public demo's uptime monitor.
// They say nothing about the server (no pod name: the API is on the internet), and
// they're static, so being unthrottled is cheap.
// No rate limit: the kubelet's probes would all count against the node's address.
@Controller()
@SkipThrottle({ ip: true })
export class HealthController {
  @Get('healthz')
  healthz() {
    return { status: 'ok' };
  }

  // TODO(milestone 2): check Postgres, Redis, and Kafka before reporting ready.
  @Get('readyz')
  readyz() {
    return { status: 'ready' };
  }
}
