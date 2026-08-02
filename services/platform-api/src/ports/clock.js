export function createClockPort(now = () => new Date()) {
  if (typeof now !== "function") throw new TypeError("Clock now function is required");
  return Object.freeze({
    now() {
      const value = now();
      const instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
      if (!Number.isFinite(instant.getTime())) throw new TypeError("Clock returned an invalid instant");
      return instant;
    },
    nowIso() {
      return this.now().toISOString();
    },
    after(milliseconds) {
      if (!Number.isFinite(milliseconds)) throw new TypeError("Clock duration must be finite");
      return new Date(this.now().getTime() + milliseconds).toISOString();
    },
    isExpired(instant) {
      return Boolean(instant) && Date.parse(instant) <= this.now().getTime();
    }
  });
}
