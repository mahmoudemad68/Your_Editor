/**
 * The client address used for the process-local credential limit.
 * X-Forwarded-For is ignored unless the immediate peer is a configured proxy.
 * The client cannot choose that address by sending the header itself.
 */

export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | undefined,
  trustedProxies: readonly string[],
): string {
  const direct = normalizeIp(peer ?? "unknown");
  if (!isTrustedProxy(direct, trustedProxies)) {
    return direct;
  }
  const chain = (forwardedFor ?? "")
    .split(",")
    .map((part) => normalizeIp(part.trim()))
    .filter((part) => part.length > 0);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const hop = chain[index];
    if (hop !== undefined && !isTrustedProxy(hop, trustedProxies)) {
      return hop;
    }
  }
  return direct;
}

function isTrustedProxy(address: string, trustedProxies: readonly string[]): boolean {
  return trustedProxies.some((proxy) => normalizeIp(proxy) === address);
}

function normalizeIp(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice("::ffff:".length);
  }
  return trimmed;
}
