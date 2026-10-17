import 'reflect-metadata';
import { type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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
  const app = await NestFactory.create(AppModule, { logger: logLevels });
  app.use(httpMetrics);
  app.enableShutdownHooks();
  const metrics = serveMetrics(Number(process.env.METRICS_PORT ?? 9464));
  process.once('SIGTERM', () => metrics.close());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

bootstrap();
