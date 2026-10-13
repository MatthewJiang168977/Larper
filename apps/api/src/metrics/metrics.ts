import { createServer, type Server } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

// Prometheus metrics. Served on their own port (not through the ingress), so the
// public internet can't read them; Prometheus scrapes each pod directly.
export const registry = new Registry();
collectDefaultMetrics({ register: registry }); // event-loop lag, heap, GC, CPU

const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'API request latency, by route template (not raw URL, to bound cardinality)',
  labelNames: ['method', 'route', 'status'],
  // Fine-grained under 1 s, where the p95 we care about lives.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// Express middleware. The route is read when the response finishes, after the
// router has matched it; unmatched paths share one label.
export function httpMetrics(req: Request, res: Response, next: NextFunction) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

export function serveMetrics(port: number): Server {
  return createServer(async (req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': registry.contentType });
    res.end(await registry.metrics());
  }).listen(port, '0.0.0.0');
}
