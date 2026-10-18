import { normalizeIp } from '@nestjs/throttler';
import type { Request } from 'express';
import { isIP } from 'node:net';

/**
 * Where the per-IP limit reads the client's address (CLIENT_IP_SOURCE):
 * - `forwarded`: `req.ip`, which Express takes from X-Forwarded-For as far back as
 *   TRUST_PROXY allows (main.ts): the number of proxies in front, 1 for Traefik on
 *   k3d, or the proxies' addresses/CIDRs.
 * - `cloudflare`: CF-Connecting-IP, which Cloudflare's edge sets (a client can't
 *   override it through Cloudflare). Only from a peer TRUST_PROXY trusts, i.e. the
 *   ingress or the tunnel; anything else could have set the header itself. A request
 *   without it (an admin through the SSH tunnel) falls back to `forwarded`.
 */
export type ClientIpSource = 'forwarded' | 'cloudflare';

export function clientIpSource(): ClientIpSource {
  return process.env.CLIENT_IP_SOURCE === 'cloudflare' ? 'cloudflare' : 'forwarded';
}

export function clientIp(req: Request, source: ClientIpSource = clientIpSource()): string {
  if (source === 'cloudflare' && fromTrustedProxy(req)) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && isIP(cf.trim())) return normalizeIp(cf.trim());
  }
  // IPv6 clients are counted per /64, the smallest block one usually gets.
  return normalizeIp(req.ip ?? req.socket.remoteAddress ?? 'unknown');
}

function fromTrustedProxy(req: Request): boolean {
  const trust = req.app?.get('trust proxy fn') as ((addr: string, i: number) => boolean) | undefined;
  const peer = req.socket?.remoteAddress;
  return !!trust && !!peer && trust(peer, 0);
}
