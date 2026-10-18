import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { hostname } from 'node:os';

// Liveness/readiness probes for Kubernetes. `pod` lets you watch the load
// balancer spread requests across replicas: `curl` a few times and it changes.
// No rate limit: the kubelet's probes would all count against the node's address.
@Controller()
@SkipThrottle({ ip: true })
export class HealthController {
  @Get('healthz')
  healthz() {
    return { status: 'ok', pod: hostname() };
  }

  // TODO(milestone 2): check Postgres, Redis, and Kafka before reporting ready.
  @Get('readyz')
  readyz() {
    return { status: 'ready', pod: hostname() };
  }
}
