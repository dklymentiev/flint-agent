// Network guard — beforeHook that blocks private IPs and rate-limits requests

/**
 * Parse a URL and check if it targets a private/internal IP range.
 */
function isPrivateIP(hostname) {
  // Handle IPv4
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b, c, d] = ipv4Match.map(Number);
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0
    if (a === 0 && b === 0 && c === 0 && d === 0) return true;
  }

  // Handle common hostnames that resolve to private IPs
  if (hostname === "localhost") return true;

  // IPv6 loopback
  if (hostname === "::1" || hostname === "[::1]") return true;

  return false;
}

/**
 * Sliding-window rate limiter.
 */
function createRateLimiter(maxPerMinute, windowMs) {
  const timestamps = [];

  return function checkRate() {
    const now = Date.now();
    const cutoff = now - windowMs;

    // Remove expired entries
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= maxPerMinute) {
      return false; // rate limited
    }

    timestamps.push(now);
    return true; // allowed
  };
}

/**
 * Create a network-guard beforeHook.
 * @param {object} policy - Security policy from policies.js
 * @param {number} [agentPort] - Agent's own port (excluded from private IP block)
 * @returns {Function} beforeHook(name, args)
 */
export function createNetworkGuardHook(policy, agentPort) {
  const networkPolicy = policy.network || {};
  const rateLimiter = networkPolicy.rateLimit
    ? createRateLimiter(networkPolicy.rateLimit.maxPerMinute, networkPolicy.rateLimit.windowMs)
    : null;

  return function networkGuardHook(name, args) {
    if (name !== "web_fetch" && name !== "web_search") return null;

    // web_search doesn't have a user-provided URL to validate
    if (name === "web_search") {
      // Just apply rate limiting
      if (rateLimiter && !rateLimiter()) {
        return { deny: true, reason: "rate limited: too many network requests per minute" };
      }
      return null;
    }

    // web_fetch — validate URL
    const url = args.url;
    if (!url || typeof url !== "string") return null;

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { deny: true, reason: `invalid URL: "${url}"` };
    }

    // Block non-http(s) protocols
    if (networkPolicy.blockNonHttpProtocols) {
      const protocol = parsed.protocol.toLowerCase();
      if (protocol !== "http:" && protocol !== "https:") {
        return { deny: true, reason: `blocked protocol: ${protocol} (only http/https allowed)` };
      }
    }

    // Block private IPs
    if (networkPolicy.blockPrivateIPs) {
      const hostname = parsed.hostname;
      if (isPrivateIP(hostname)) {
        // Allow agent's own port on localhost
        const port = parseInt(parsed.port, 10) || (parsed.protocol === "https:" ? 443 : 80);
        if (hostname === "localhost" || hostname === "127.0.0.1") {
          if (agentPort && port === agentPort) {
            // Allow self-requests (e.g., timer callbacks)
          } else {
            return { deny: true, reason: `blocked private IP: ${hostname}:${port}` };
          }
        } else {
          return { deny: true, reason: `blocked private IP: ${hostname}` };
        }
      }
    }

    // Rate limiting
    if (rateLimiter && !rateLimiter()) {
      return { deny: true, reason: "rate limited: too many network requests per minute" };
    }

    return null;
  };
}
