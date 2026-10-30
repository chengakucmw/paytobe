const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ADDRESS_RULES = Object.freeze({
  evm: /^0x[0-9a-fA-F]{40}$/,
  stellar: /^G[A-Z2-7]{55}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,48}$/,
  xrp: /^r[1-9A-HJ-NP-Za-km-z]{12,40}$/,
  bitcoin: /^(bc1|[13])[A-HJ-NP-Za-km-z0-9]{18,90}$/,
  litecoin: /^(ltc1|[LM3])[A-HJ-NP-Za-km-z0-9]{18,90}$/i,
  bitcoin_cash: /^(bitcoincash:)?[qp][a-z0-9]{20,90}$/i,
  dogecoin: /^D[1-9A-HJ-NP-Za-km-z]{25,40}$/,
  move: /^0x[0-9a-fA-F]{48,80}$/,
  ton: /^[EU]Q[A-Za-z0-9_-]{20,80}$/,
  cardano: /^addr1[0-9a-z]{20,120}$/,
  cosmos: /^cosmos1[0-9a-z]{20,80}$/,
  substrate: /^[1-9A-HJ-NP-Za-km-z]{35,55}$/,
  hedera: /^0\.0\.[0-9]+$/,
  starknet: /^0x[0-9a-fA-F]{48,80}$/,
  algorand: /^[A-Z2-7]{40,70}$/,
  tezos: /^tz[1-3][1-9A-HJ-NP-Za-km-z]{20,40}$/,
  icp: /^[a-z0-9-]{20,90}$/i,
  filecoin: /^f[0-4][a-z0-9]{10,90}$/i
});

export const UNSUPPORTED_TRANSFER_NETWORKS = Object.freeze([
  "tron",
  "trx",
  "trc10",
  "trc20",
  "near",
  "near_protocol"
]);

export const SUPPORTED_TRANSFER_ASSETS = deepFreeze([
  asset("xlm-stellar", "stellar_xlm", "XLM", "Stellar", "stellar_public", "stellar", {
    decimals: 7,
    memo_label: "Memo",
    memo_policy: { mode: "optional", max_bytes: 28, charset: "printable_ascii" },
    network_aliases: ["stellar_testnet"],
    key_curve: "ed25519",
    coin_type: 148
  }),
  asset("sol-solana", "solana_sol", "SOL", "Solana", "solana_mainnet", "solana", { decimals: 9, key_curve: "ed25519", coin_type: 501 }),
  asset("eth-ethereum", "ethereum_eth", "ETH", "Ethereum", "ethereum_mainnet", "evm", { decimals: 18, chain_id: 1, key_curve: "secp256k1", coin_type: 60 }),
  asset("usdc-base", "base_usdc", "USDC", "Base", "base_mainnet", "evm", { decimals: 6, chain_id: 8453, token_contract: BASE_USDC_CONTRACT, key_curve: "secp256k1", coin_type: 60 }),
  asset("btc-bitcoin", "bitcoin_btc", "BTC", "Bitcoin", "bitcoin_mainnet", "bitcoin", { decimals: 8, execution_mode: "prepared_payload", key_curve: "secp256k1", coin_type: 0 }),
  asset("bnb-bnb-smart-chain", "bsc_bnb", "BNB", "BNB Smart Chain", "bsc_mainnet", "evm", { decimals: 18, chain_id: 56, key_curve: "secp256k1", coin_type: 60 }),
  asset("xrp-xrp-ledger", "xrpl_xrp", "XRP", "XRP Ledger", "xrpl_mainnet", "xrp", {
    decimals: 6,
    memo_label: "Destination tag",
    memo_policy: { mode: "optional", max_bytes: 10, charset: "digits", max_value: "4294967295" },
    execution_mode: "prepared_payload",
    key_curve: "secp256k1",
    coin_type: 144
  }),
  asset("eth-arbitrum-one", "arbitrum_eth", "ETH", "Arbitrum One", "arbitrum_one", "evm", { decimals: 18, chain_id: 42161, key_curve: "secp256k1", coin_type: 60 }),
  asset("pol-polygon-pos", "polygon_pol", "POL", "Polygon PoS", "polygon_pos", "evm", { decimals: 18, chain_id: 137, key_curve: "secp256k1", coin_type: 60 }),
  asset("avax-avalanche-c-chain", "avalanche_avax", "AVAX", "Avalanche C-Chain", "avalanche_c_chain", "evm", { decimals: 18, chain_id: 43114, key_curve: "secp256k1", coin_type: 60 }),
  asset("eth-optimism", "optimism_eth", "ETH", "Optimism", "optimism_mainnet", "evm", { decimals: 18, chain_id: 10, key_curve: "secp256k1", coin_type: 60 }),
  asset("sui-sui", "sui_sui", "SUI", "Sui", "sui_mainnet", "move", { decimals: 9, execution_mode: "prepared_payload", key_curve: "ed25519", coin_type: 784 }),
  asset("apt-aptos", "aptos_apt", "APT", "Aptos", "aptos_mainnet", "move", { decimals: 8, execution_mode: "prepared_payload", key_curve: "ed25519", coin_type: 637 }),
  asset("ton-ton", "ton_ton", "TON", "TON", "ton_mainnet", "ton", { decimals: 9, execution_mode: "prepared_payload", key_curve: "ed25519", coin_type: 607 }),
  asset("ada-cardano", "cardano_ada", "ADA", "Cardano", "cardano_mainnet", "cardano", { decimals: 6, execution_mode: "prepared_payload", key_curve: "ed25519", coin_type: 1815 }),
  asset("atom-cosmos-hub", "cosmos_atom", "ATOM", "Cosmos Hub", "cosmos_hub", "cosmos", { decimals: 6, execution_mode: "prepared_payload", key_curve: "secp256k1", coin_type: 118 }),
  asset("dot-polkadot", "polkadot_dot", "DOT", "Polkadot", "polkadot_mainnet", "substrate", { decimals: 10, execution_mode: "prepared_payload", key_curve: "ed25519", coin_type: 354 }),
  asset("hbar-hedera", "hedera_hbar", "HBAR", "Hedera", "hedera_mainnet", "hedera", {
    decimals: 8,
    memo_label: "Memo",
    memo_policy: { mode: "optional", max_bytes: 100, charset: "printable_ascii" },
    execution_mode: "prepared_payload",
    key_curve: "ed25519",
    coin_type: 3030
  }),
  asset("cro-cronos", "cronos_cro", "CRO", "Cronos", "cronos_mainnet", "evm", { decimals: 18, chain_id: 25, key_curve: "secp256k1", coin_type: 60 }),
  asset("mnt-mantle", "mantle_mnt", "MNT", "Mantle", "mantle_mainnet", "evm", { decimals: 18, chain_id: 5000, key_curve: "secp256k1", coin_type: 60 }),
  asset("strk-starknet", "starknet_strk", "STRK", "Starknet", "starknet_mainnet", "starknet", { decimals: 18, execution_mode: "prepared_payload", key_curve: "stark", coin_type: 9004 }),
  asset("eth-zksync-era", "zksync_eth", "ETH", "ZKsync Era", "zksync_era", "evm", { decimals: 18, chain_id: 324, key_curve: "secp256k1", coin_type: 60 }),
  asset("eth-linea", "linea_eth", "ETH", "Linea", "linea_mainnet", "evm", { decimals: 18, chain_id: 59144, key_curve: "secp256k1", coin_type: 60 }),
  asset("algo-algorand", "algorand_algo", "ALGO", "Algorand", "algorand_mainnet", "algorand", { decimals: 6, execution_mode: "prepared_payload", key_curve: "ed25519", coin_type: 283 }),
  asset("xtz-tezos", "tezos_xtz", "XTZ", "Tezos", "tezos_mainnet", "tezos", { decimals: 6, execution_mode: "prepared_payload", key_curve: "ed25519", coin_type: 1729 }),
  asset("icp-internet-computer", "internet_computer_icp", "ICP", "Internet Computer", "internet_computer", "icp", { decimals: 8, execution_mode: "prepared_payload", key_curve: "ed25519", coin_type: 223 }),
  asset("fil-filecoin", "filecoin_fil", "FIL", "Filecoin", "filecoin_mainnet", "filecoin", { decimals: 18, execution_mode: "prepared_payload", key_curve: "secp256k1", coin_type: 461 }),
  asset("ltc-litecoin", "litecoin_ltc", "LTC", "Litecoin", "litecoin_mainnet", "litecoin", { decimals: 8, execution_mode: "prepared_payload", key_curve: "secp256k1", coin_type: 2 }),
  asset("bch-bitcoin-cash", "bitcoin_cash_bch", "BCH", "Bitcoin Cash", "bitcoin_cash_mainnet", "bitcoin_cash", { decimals: 8, execution_mode: "prepared_payload", key_curve: "secp256k1", coin_type: 145 }),
  asset("doge-dogecoin", "dogecoin_doge", "DOGE", "Dogecoin", "dogecoin_mainnet", "dogecoin", { decimals: 8, execution_mode: "prepared_payload", key_curve: "secp256k1", coin_type: 3 })
]);

export const SUPPORTED_TRANSFER_ASSET_IDS = Object.freeze(SUPPORTED_TRANSFER_ASSETS.map((item) => item.id));
export const SUPPORTED_TRANSFER_RAILS = Object.freeze(SUPPORTED_TRANSFER_ASSETS.map((item) => item.rail));
export const IMPLEMENTED_TRANSFER_RAILS = Object.freeze(SUPPORTED_TRANSFER_ASSETS
  .filter((item) => item.signer_status === "implemented")
  .map((item) => item.rail));

export function findSupportedTransferAsset(input = {}) {
  const rail = normalize(input.rail);
  if (rail) {
    const byRail = SUPPORTED_TRANSFER_ASSETS.find((item) => item.rail === rail);
    if (byRail) return byRail;
  }

  const network = normalize(input.network);
  const symbol = normalizeSymbol(input.asset || input.symbol || input.token);
  const chainId = numberOrNull(input.chain_id ?? input.chainId);
  return SUPPORTED_TRANSFER_ASSETS.find((item) => {
    if (symbol && symbol !== item.symbol) return false;
    if (network && network !== item.network && !item.network_aliases.includes(network)) return false;
    if (chainId !== null && item.chain_id !== undefined && Number(item.chain_id) !== chainId) return false;
    if (chainId !== null && item.chain_id !== undefined && Number(item.chain_id) === chainId) return Boolean(symbol || network);
    return Boolean(symbol && network);
  });
}

export function validateTransferAddress(asset, address) {
  const definition = typeof asset === "string" ? findSupportedTransferAsset({ rail: asset }) : asset;
  if (!definition) return false;
  const rule = ADDRESS_RULES[definition.family];
  return rule ? rule.test(String(address || "")) : false;
}

export function detectUnsupportedTransferTarget(input = {}) {
  const values = valuesForPolicy(input);
  const tronAddress = values.find((value) => /^T[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(value));
  if (tronAddress || values.some((value) => /\b(tron|trx|trc10|trc20)\b/i.test(value))) {
    return {
      blocked: true,
      code: "unsupported_tron",
      message: "TRON, TRX, TRC10, and TRC20 are not supported by Paytobe."
    };
  }
  if (values.some((value) => /\bnear\b|near[-_ ]?protocol/i.test(value))) {
    return {
      blocked: true,
      code: "unsupported_near",
      message: "NEAR is removed from the v1 supported transfer asset list."
    };
  }
  return { blocked: false };
}

export function transferAssetAdapterWarning(asset) {
  if (!asset || asset.signer_status === "implemented") return null;
  return {
    code: "adapter_required",
    message: `${asset.symbol} on ${asset.chain} is registered for v1 but still requires a chain-family signer before broadcast.`,
    details: {
      field: "payment.rail",
      rail: asset.rail,
      network: asset.network,
      chain_family: asset.family
    }
  };
}

function asset(id, rail, symbol, chain, network, family, options = {}) {
  return {
    id,
    rail,
    symbol,
    asset: symbol,
    chain,
    network,
    family,
    decimals: options.decimals,
    chain_id: options.chain_id,
    token_contract: options.token_contract,
    fee_asset: options.fee_asset || nativeFeeAsset(symbol, family),
    memo_label: options.memo_label || "",
    memo_policy: options.memo_policy || { mode: "forbidden", max_bytes: 0, charset: "none" },
    signer_status: options.signer_status || "implemented",
    execution_mode: options.execution_mode || "direct_broadcast",
    key_curve: options.key_curve || "",
    coin_type: options.coin_type,
    network_aliases: Object.freeze([network, ...(options.network_aliases || [])])
  };
}

function nativeFeeAsset(symbol, family) {
  if (family === "evm") return symbol;
  return symbol;
}

function valuesForPolicy(input) {
  if (typeof input === "string") return [input];
  if (!input || typeof input !== "object") return [];
  return [
    input.rail,
    input.network,
    input.chain,
    input.asset,
    input.symbol,
    input.token,
    input.to,
    input.recipient,
    input.address,
    input.token_contract,
    input.contract
  ].filter((value) => value !== undefined && value !== null).map(String);
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      if (item && typeof item === "object") deepFreeze(item);
    }
  }
  return Object.freeze(value);
}
