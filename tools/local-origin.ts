export function validateLocalOrigin(value: string): string {
  const url = new URL(value);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "local E2E URLs must be HTTP(S) loopback origins without credentials, paths, queries, or fragments",
    );
  }
  return url.origin;
}
