export function createMemoryEmailAdapter() {
  const deliveries = [];
  const stepUps = [];
  return Object.freeze({
    async sendVerification({ to, token, expires_at, purpose = "verification" }) {
      deliveries.push(Object.freeze({ to, token, expires_at, purpose }));
      return { accepted: true };
    },
    latest(to = "") {
      return [...deliveries].reverse().find((delivery) => !to || delivery.to === to) || null;
    },
    count() {
      return deliveries.length;
    },
    async sendStepUp({ to, token, expires_at }) {
      stepUps.push(Object.freeze({ to, token, expires_at }));
      return { accepted: true };
    },
    latestStepUp(to = "") {
      return [...stepUps].reverse().find((delivery) => !to || delivery.to === to) || null;
    },
    clear() {
      deliveries.length = 0;
      stepUps.length = 0;
    }
  });
}
