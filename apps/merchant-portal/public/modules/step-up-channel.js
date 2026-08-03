const CHANNEL_NAME = "velarumpay-merchant-step-up-v1";
const TOKEN_PATTERN = /^mstep_[A-Za-z0-9_-]{43}$/;

export function createStepUpChannel({
  BroadcastChannelImpl = globalThis.BroadcastChannel,
  onChallenge = () => {},
  onCompleted = () => {},
  onFailed = () => {}
} = {}) {
  if (typeof BroadcastChannelImpl !== "function") return null;
  let channel;
  try {
    channel = new BroadcastChannelImpl(CHANNEL_NAME);
  } catch {
    return null;
  }
  const receive = (event) => {
    const message = event?.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "step-up-challenge" && TOKEN_PATTERN.test(String(message.token || ""))) {
      onChallenge(message.token);
    } else if (message.type === "step-up-completed") {
      onCompleted();
    } else if (message.type === "step-up-failed") {
      onFailed(safeMessage(message.message));
    }
  };
  if (typeof channel.addEventListener === "function") channel.addEventListener("message", receive);
  else channel.onmessage = receive;

  return Object.freeze({
    publishChallenge(token) {
      const value = String(token || "").trim();
      if (!TOKEN_PATTERN.test(value)) return false;
      channel.postMessage({ type: "step-up-challenge", token: value });
      return true;
    },
    publishCompleted() {
      channel.postMessage({ type: "step-up-completed" });
    },
    publishFailed(message) {
      channel.postMessage({ type: "step-up-failed", message: safeMessage(message) });
    },
    close() {
      channel.close();
    }
  });
}

function safeMessage(value) {
  return String(value || "Security verification could not be completed.").trim().slice(0, 180);
}
