import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ok and ready, and nothing about the server', async () => {
    const mod = await Test.createTestingModule({ controllers: [HealthController] }).compile();
    const health = mod.get(HealthController);
    expect(health.healthz()).toEqual({ status: 'ok' });
    expect(health.readyz()).toEqual({ status: 'ready' });
  });
});
