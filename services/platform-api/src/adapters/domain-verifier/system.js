import { resolve4, resolve6, resolveTxt } from "node:dns/promises";

export function createSystemDomainVerifierPorts() {
  return Object.freeze({
    resolver: Object.freeze({
      async resolve(hostname) {
        const [ipv4, ipv6] = await Promise.all([
          resolve4(hostname).catch((error) => error?.code === "ENODATA" ? [] : Promise.reject(error)),
          resolve6(hostname).catch((error) => error?.code === "ENODATA" ? [] : Promise.reject(error))
        ]);
        return [...ipv4, ...ipv6];
      },
      async resolveTxt(hostname) {
        return (await resolveTxt(hostname)).map((parts) => parts.join(""));
      }
    }),
    fetcher: Object.freeze({
      fetch(url, options = {}) {
        return fetch(url, { ...options, signal: AbortSignal.timeout(options.timeout_ms || 5_000) });
      }
    })
  });
}
