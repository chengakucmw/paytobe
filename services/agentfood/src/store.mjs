import fs from "node:fs";
import path from "node:path";

export class AgentFoodStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.state = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        version: 2,
        orders: Array.isArray(parsed.orders) ? parsed.orders : [],
        idempotency: parsed.idempotency && typeof parsed.idempotency === "object" ? parsed.idempotency : {},
        webhook_events: Array.isArray(parsed.webhook_events) ? parsed.webhook_events : []
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { version: 2, orders: [], idempotency: {}, webhook_events: [] };
    }
  }

  order(orderId) {
    return this.state.orders.find((order) => order.order_id === orderId) || null;
  }

  orderByIdempotency(key) {
    const orderId = this.state.idempotency[String(key || "")];
    return orderId ? this.order(orderId) : null;
  }

  createOrder(order, idempotencyKey) {
    const existing = this.orderByIdempotency(idempotencyKey);
    if (existing) return { order: existing, duplicate: true };
    this.state.orders.push(structuredClone(order));
    this.state.idempotency[idempotencyKey] = order.order_id;
    this.persist();
    return { order: this.order(order.order_id), duplicate: false };
  }

  updateOrder(orderId, patch) {
    const index = this.state.orders.findIndex((order) => order.order_id === orderId);
    if (index < 0) return null;
    this.state.orders[index] = {
      ...this.state.orders[index],
      ...structuredClone(patch),
      updated_at: new Date().toISOString()
    };
    this.persist();
    return this.state.orders[index];
  }

  rememberWebhookEvent(eventId) {
    const value = String(eventId || "");
    if (this.state.webhook_events.includes(value)) return false;
    this.state.webhook_events.push(value);
    if (this.state.webhook_events.length > 10_000) this.state.webhook_events.splice(0, this.state.webhook_events.length - 10_000);
    this.persist();
    return true;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }
}
