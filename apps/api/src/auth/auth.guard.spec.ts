import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ClerkAuthGuard } from './auth.guard';
import { frontendApiFromPublishableKey } from './publishable-key';
import type { UsersService } from './users.service';

const ctxFor = (headers: Record<string, string>) => {
  const req: { headers: Record<string, string>; user?: unknown } = { headers };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { ctx, req };
};

describe('ClerkAuthGuard', () => {
  const users = { ensure: jest.fn(async () => '42') } as unknown as UsersService;
  const verify = jest.fn(async (token: string) => {
    if (token !== 'good') throw new Error('bad signature');
    return { clerkId: 'user_abc' };
  });
  const guard = new ClerkAuthGuard(verify, users);

  it('attaches our user id for a valid token', async () => {
    const { ctx, req } = ctxFor({ authorization: 'Bearer good' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({ clerkId: 'user_abc', id: '42' });
  });

  it('rejects a missing header', async () => {
    await expect(guard.canActivate(ctxFor({}).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token that fails verification as 401, not 500', async () => {
    const { ctx } = ctxFor({ authorization: 'Bearer forged' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('frontendApiFromPublishableKey', () => {
  it('decodes the instance host', () => {
    const key = 'pk_test_' + Buffer.from('example-1.clerk.accounts.dev$').toString('base64');
    expect(frontendApiFromPublishableKey(key)).toBe('example-1.clerk.accounts.dev');
  });

  it('rejects things that are not publishable keys', () => {
    expect(() => frontendApiFromPublishableKey('sk_test_abc')).toThrow();
  });
});
