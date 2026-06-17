const EVM_ADDRESS = /0x[a-fA-F0-9]{40}/;
const STELLAR_ADDRESS = /G[A-Z2-7]{55}/;

export function parsePaymentCommand(text) {
  const input = String(text || "").trim();
  const lower = input.toLowerCase();
  const evm = input.match(EVM_ADDRESS)?.[0] || "";
  const stellar = input.match(STELLAR_ADDRESS)?.[0] || "";

  if ((lower.includes("usdc") || input.includes("USDC")) && (lower.includes("base") || input.includes("base")) && evm) {
    const amount = amountBeforeAsset(input, "USDC") || amountAfterVerb(input);
    if (!amount) throw new Error("Could not parse USDC amount");
    return {
      rail: "evm_erc20",
      network: "base_mainnet",
      chain_id: 8453,
      asset: "USDC",
      token_contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
      amount,
      to: evm
    };
  }

  const mentionsXlm = lower.includes("xlm") || lower.includes("stellar") || input.includes("恒星");
  if (mentionsXlm && stellar) {
    const amount = amountBeforeAsset(input, "XLM") || amountBeforeChineseAsset(input) || amountAfterVerb(input);
    if (!amount) throw new Error("Could not parse XLM amount");
    return {
      rail: "stellar_xlm",
      network: process.env.STELLAR_NETWORK || "stellar_public",
      asset: "XLM",
      decimals: 7,
      amount,
      to: stellar
    };
  }

  throw new Error("Unsupported payment command. Try: send 10 USDC on Base to 0x... or send 25 XLM to G...");
}

function amountBeforeAsset(text, asset) {
  const re = new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${asset}`, "i");
  return text.match(re)?.[1] || "";
}

function amountBeforeChineseAsset(text) {
  return text.match(/([0-9]+(?:\.[0-9]+)?)\s*(恒星币|恒星|xlm|XLM)/)?.[1] || "";
}

function amountAfterVerb(text) {
  return text.match(/(?:send|pay|transfer|转账|支付)\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1] || "";
}

