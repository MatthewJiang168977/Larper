import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { httpMetrics, serveMetrics } from './metrics/metrics';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(httpMetrics);
  app.enableShutdownHooks();
  const metrics = serveMetrics(Number(process.env.METRICS_PORT ?? 9464));
  process.once('SIGTERM', () => metrics.close());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

bootstrap();
