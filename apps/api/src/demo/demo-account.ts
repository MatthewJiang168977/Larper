import { randomBytes } from 'node:crypto';
import type { ClerkApi } from './clerk-api';

// The public demo's shared Clerk user (scripts/demo-account.sh creates it). Visitors
// sign in as it with a one-time sign-in token from POST /demo/sign-in: no password to
// show, and no email code (Clerk's new-device check), since the account has no inbox.
//
// Everyone who signs in has the whole account, so anyone could add an email, a phone,
// a passkey or two-step verification, or set a name. Two-step verification would lock
// the next visitor out, so the sign-in endpoint takes it off before each token. The
// nightly reset (ops/demo-reset.ts) puts the rest back.

/** How long a sign-in token stays usable. The web app redeems it right away. */
export const TICKET_TTL_S = 60;

export interface DemoConfig {
  userId: string;
  email: string;
}

/** DEMO_CLERK_USER_ID and DEMO_EMAIL (Helm demo.*); null when the demo is off. */
export function demoConfig(env: NodeJS.ProcessEnv): DemoConfig | null {
  const userId = env.DEMO_CLERK_USER_ID?.trim();
  if (!userId) return null;
  if (!/^user_[A-Za-z0-9]+$/.test(userId)) throw new Error('DEMO_CLERK_USER_ID must be a Clerk user id (user_...)');
  const email = env.DEMO_EMAIL?.trim() ?? '';
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('DEMO_EMAIL must be the demo account\'s email address');
  return { userId, email };
}

// The parts of Clerk's User object these functions read.
export interface ClerkUser {
  id: string;
  two_factor_enabled: boolean;
  locked: boolean;
  has_image: boolean;
  primary_email_address_id: string | null;
  email_addresses: { id: string; email_address: string }[];
  phone_numbers: { id: string }[];
  external_accounts: { id: string }[];
  passkeys?: { id: string }[];
  web3_wallets?: { id: string }[];
}

/**
 * A sign-in token for the demo user, after taking off anything that would stop a
 * visitor from using it: two-step verification (a code nobody has) or a lockout.
 */
export async function demoSignInToken(clerk: ClerkApi, cfg: DemoConfig): Promise<{ token: string; repaired: string[] }> {
  const user = await clerk<ClerkUser>('GET', `/users/${cfg.userId}`);
  const repaired: string[] = [];
  if (user.two_factor_enabled) {
    await clerk('DELETE', `/users/${cfg.userId}/mfa`);
    repaired.push('two-step verification');
  }
  if (user.locked) {
    await clerk('POST', `/users/${cfg.userId}/unlock`);
    repaired.push('lockout');
  }
  const { token } = await clerk<{ token: string }>('POST', '/sign_in_tokens', {
    user_id: cfg.userId,
    expires_in_seconds: TICKET_TTL_S,
  });
  return { token, repaired };
}

/**
 * The Clerk half of the nightly reset: everyone signed out, then the account back to
 * how `demo-account.sh create` left it. Its one email, as primary; no phone, social
 * login, passkey, wallet, two-step verification, name or picture; a new random
 * password nobody knows (visitors use sign-in tokens, never a password); and it still
 * can't delete itself or create organizations. Returns what it changed.
 */
export async function restoreDemoUser(clerk: ClerkApi, cfg: DemoConfig): Promise<string[]> {
  const id = cfg.userId;
  const done: string[] = [];

  const sessions = await clerk<{ id: string }[]>('GET', `/sessions?user_id=${id}&status=active&limit=500`);
  for (const s of sessions) await clerk('POST', `/sessions/${s.id}/revoke`);
  done.push(`revoked ${sessions.length} session(s)`);

  const user = await clerk<ClerkUser>('GET', `/users/${id}`);
  if (user.two_factor_enabled) {
    await clerk('DELETE', `/users/${id}/mfa`);
    done.push('removed two-step verification');
  }
  if (user.locked) {
    await clerk('POST', `/users/${id}/unlock`);
    done.push('unlocked');
  }

  // The demo email first (back as primary if a visitor changed that), then the rest.
  const own = user.email_addresses.find((e) => e.email_address.toLowerCase() === cfg.email.toLowerCase());
  if (!own) {
    await clerk('POST', '/email_addresses', { user_id: id, email_address: cfg.email, verified: true, primary: true });
    done.push('re-added its email');
  } else if (user.primary_email_address_id !== own.id) {
    await clerk('PATCH', `/email_addresses/${own.id}`, { primary: true });
    done.push('made its email primary again');
  }
  const extra = {
    emails: user.email_addresses.filter((e) => e !== own).map((e) => `/email_addresses/${e.id}`),
    phones: user.phone_numbers.map((p) => `/phone_numbers/${p.id}`),
    'social logins': user.external_accounts.map((a) => `/users/${id}/external_accounts/${a.id}`),
    passkeys: (user.passkeys ?? []).map((p) => `/users/${id}/passkeys/${p.id}`),
    wallets: (user.web3_wallets ?? []).map((w) => `/users/${id}/web3_wallets/${w.id}`),
  };
  for (const [what, paths] of Object.entries(extra)) {
    for (const path of paths) await clerk('DELETE', path);
    if (paths.length) done.push(`removed ${paths.length} ${what}`);
  }
  if (user.has_image) {
    await clerk('DELETE', `/users/${id}/profile_image`);
    done.push('removed its picture');
  }

  await clerk('PATCH', `/users/${id}`, {
    password: randomBytes(24).toString('base64url'),
    skip_password_checks: true,
    first_name: '',
    last_name: '',
    delete_self_enabled: false,
    create_organization_enabled: false,
  });
  done.push('new random password, no name, still locked down');
  return done;
}
