// A Clerk publishable key is "pk_test_" + base64("<frontend-api-host>$"). The host
// serves the instance's public signing keys, so the API can verify session tokens
// without ever holding the Clerk secret key.
export function frontendApiFromPublishableKey(key: string): string {
  const m = /^pk_(test|live)_(.+)$/.exec(key);
  if (!m) throw new Error('CLERK_PUBLISHABLE_KEY is not a Clerk publishable key');
  const host = Buffer.from(m[2], 'base64').toString('utf8').replace(/\$$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]+$/i.test(host)) {
    throw new Error('CLERK_PUBLISHABLE_KEY does not decode to a hostname');
  }
  return host;
}
