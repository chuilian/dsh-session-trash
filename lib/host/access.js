/**
 * Who may call this plugin's host routes.
 *
 * The routes can move and erase session logs, so they are restricted the same way
 * DSH already restricts its own `/api` bridge: the request's authority must be a
 * loopback address or an authority this deployment declares as trusted, and the
 * browser fences (`Sec-Fetch-Site`, `Origin`) must not name another site.
 *
 * The rule deliberately mirrors the shipped `isTrustedApiRequest` in
 * `@deepseek-ai/dsh-client-connection` rather than inventing a narrower one:
 * accepting only `127.0.0.1` would break an ordinary LAN deployment, and
 * accepting more than loopback without the browser fences would open the
 * DNS-rebinding and cross-site paths those fences exist to close.
 *
 * Note on pairing: earlier revisions of this plugin also accepted a "paired
 * device" cookie through a `remoteWebUiPairing` service. No such service exists
 * in DSH 0.2.0-rc.2 (the identifier appears nowhere in the shipped application),
 * so that branch was dead code and has been removed rather than documented as if
 * it worked. Trusted non-loopback deployments are supported through
 * `trustedHosts`, which is real and readable from the connection service.
 *
 * @module dsh-session-trash/host/access
 */

/**
 * Whether a hostname is a loopback address in any of the spellings a browser or
 * a proxy may produce: `localhost`, `::1`, or any `127.0.0.0/8` literal.
 *
 * @param {string|undefined} hostname - hostname from a parsed authority.
 * @returns {boolean} true for loopback spellings.
 */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== "string") return false;
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Parse an authority (`host`, `host:port`, `[::1]:port`) into its parts.
 *
 * @param {string} authority - the `Host` header or a `trustedHosts` entry.
 * @returns {{hostname: string, host: string, port: string}|undefined} the parts, or undefined when unparseable.
 */
export function parseAuthority(authority) {
  if (typeof authority !== "string" || authority === "") return undefined;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end === -1) return undefined;
    const hostname = authority.slice(0, end + 1);
    const rest = authority.slice(end + 1);
    if (rest === "") return { hostname, host: authority, port: "" };
    if (!rest.startsWith(":")) return undefined;
    return { hostname, host: authority, port: rest.slice(1) };
  }
  const separator = authority.lastIndexOf(":");
  if (separator === -1) return { hostname: authority, host: authority, port: "" };
  const hostname = authority.slice(0, separator);
  const port = authority.slice(separator + 1);
  if (hostname === "" || !/^\d+$/.test(port)) return { hostname: authority, host: authority, port: "" };
  return { hostname, host: authority, port };
}

/**
 * Whether a request authority matches one configured trusted host.
 *
 * A port-less entry matches any port for that host; an entry with a port must
 * match the whole authority.
 *
 * @param {{hostname: string, host: string}} hostUrl - parsed request authority.
 * @param {string[]} trustedHosts - configured authorities.
 * @returns {boolean} true when the authority is trusted.
 */
export function isTrustedAuthority(hostUrl, trustedHosts) {
  return (Array.isArray(trustedHosts) ? trustedHosts : []).some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return entryUrl.port === "" ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
}

/**
 * Read the authorities this deployment serves, from the connection service when
 * it is mounted and from this plugin's own config as an addition.
 *
 * @param {object} ctx - host context, which may expose `connection`.
 * @param {string[]} [extra] - additional authorities from plugin config.
 * @returns {string[]} requested authorities.
 */
export function trustedAuthorities(ctx, extra = []) {
  const fromConfig = Array.isArray(extra) ? extra : [];
  let fromConnection = [];
  try {
    const connection = ctx.get?.("connection");
    if (Array.isArray(connection?.trustedHosts)) fromConnection = connection.trustedHosts;
  } catch {
    /* a deployment without the connection service trusts loopback only */
  }
  return [...new Set([...fromConnection, ...fromConfig])];
}

/**
 * Whether the request authority passes the host fence.
 *
 * @param {import("node:http").IncomingMessage} request - incoming request.
 * @param {string[]} trustedHosts - authorities this deployment serves.
 * @returns {boolean} true when the authority is loopback or trusted.
 */
export function isTrustedAuthorityRequest(request, trustedHosts) {
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  return isLoopbackHostname(hostUrl.hostname) || isTrustedAuthority(hostUrl, trustedHosts);
}

/**
 * Whether this request may enter the routes.
 *
 * Three fences, all required: a loopback or trusted authority (so a DNS-rebinding
 * name fails), no cross-site `Sec-Fetch-Site` (so another site's page fails), and
 * an absent or same-authority `Origin` (so a request forged from another origin
 * fails even when it reaches loopback).
 *
 * @param {import("node:http").IncomingMessage} request - incoming request.
 * @param {string[]} trustedHosts - authorities this deployment serves.
 * @returns {boolean} true when the caller is trusted.
 */
export function isTrustedCaller(request, trustedHosts) {
  if (!isTrustedAuthorityRequest(request, trustedHosts)) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const hostUrl = parseAuthority(request.headers.host);
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}
