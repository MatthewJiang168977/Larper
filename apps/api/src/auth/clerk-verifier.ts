import { createRemoteJWKSet, jwtVerify } from 'jose';
import { frontendApiFromPublishableKey } from './publishable-key';
import type { SessionVerifier } from './session-verifier';

// Verifies a Clerk session JWT: RS256 signature against the instance JWKS (fetched
// once, cached, refetched on an unknown key id), issuer, expiry, and `azp`, which
// is the origin that requested the token. Checking azp stops a token minted for
// some other site on this Clerk instance from being replayed against us.
export function clerkVerifier(publishableKey: string, authorizedParties: string[]): SessionVerifier {
  const issuer = `https://${frontendApiFromPublishableKey(publishableKey)}`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, { issuer, algorithms: ['RS256'], clockTolerance: 5 });
    if (typeof payload.azp === 'string' && !authorizedParties.includes(payload.azp)) {
      throw new Error(`token azp ${payload.azp} is not an authorized party`);
    }
    if (!payload.sub) throw new Error('token has no subject');
    return { clerkId: payload.sub };
  };
}
