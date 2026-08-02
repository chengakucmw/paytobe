export class SafeWebhookTransport {
  constructor({ verifier, fetcher = globalThis.fetch, clock, timeoutMs = 10_000 }) {
    if (!verifier || typeof fetcher !== "function" || !clock) throw new TypeError("Webhook transport dependencies are required");
    this.verifier = verifier;
    this.fetcher = fetcher;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
  }

  async deliver({ url, raw_body, headers }) {
    const before = await this.verifier.inspect(url);
    const started = this.clock.now().getTime();
    const response = await this.fetcher(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers,
      body: raw_body
    });
    const after = await this.verifier.inspect(url);
    if (before.addresses.join(",") !== after.addresses.join(",")) {
      throw Object.assign(new Error("Webhook DNS rebinding detected"), { code: "webhook_dns_rebinding" });
    }
    return { status: Number(response.status), duration_ms: Math.max(0, this.clock.now().getTime() - started) };
  }
}
