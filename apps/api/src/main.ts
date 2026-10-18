import 'reflect-metadata';
import { type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { httpMetrics, serveMetrics } from './metrics/metrics';

// Nest logs debug and verbose by default. In the image (NODE_ENV=production) that
// was a stdout line per request, ~7% of API CPU (loadtest/results/profile-*).
// LOG_DEBUG=1 turns them back on.
const logLevels: LogLevel[] =
  process.env.NODE_ENV === 'production' && process.env.LOG_DEBUG !== '1'
    ? ['log', 'warn', 'error', 'fatal']
    : ['log', 'warn', 'error', 'fatal', 'debug', 'verbose'];

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: logLevels });
  // Which proxies' X-Forwarded-For to believe, for req.ip (the per-IP rate limit,
  // throttle/client-ip.ts): a hop count (1: Traefik) or their addresses/CIDRs. Unset,
  // none: req.ip is the socket's peer.
  app.set('trust proxy', trustProxy(process.env.TRUST_PROXY));
  app.use(httpMetrics);
  app.enableShutdownHooks();
  const metrics = serveMetrics(Number(process.env.METRICS_PORT ?? 9464));
  process.once('SIGTERM', () => metrics.close());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

// "2" -> 2 hops; "10.42.0.0/16,loopback" -> those addresses; unset -> false.
function trustProxy(value?: string): number | string | boolean {
  if (!value) return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

bootstrap();
