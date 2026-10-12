import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ok with the pod hostname', async () => {
    const mod = await Test.createTestingModule({ controllers: [HealthController] }).compile();
    const res = mod.get(HealthController).healthz();
    expect(res.status).toBe('ok');
    expect(typeof res.pod).toBe('string');
  });
});
