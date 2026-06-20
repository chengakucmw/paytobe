//! VelarumPay cross-platform wallet core.
//!
//! Single source of truth for HD key derivation and transaction signing shared
//! by the Android and iOS apps. Phase 1 covers **Stellar**:
//! - derivation: SLIP-0010 ed25519 at `m/44'/148'/account'` from a BIP-39 seed
//!   with an empty passphrase (SEP-0005);
//! - signing: a canonical Stellar v1 transaction (payment / create-account)
//!   built with the official `stellar-xdr` crate and signed with ed25519.
//!
//! Why this crate exists: Android (`HDWallet.java` / `StellarTransfer.java`) and
//! iOS (`StellarService.swift`) each re-implemented this by hand. If the two
//! ever drift, the *same* recovery phrase would map to *different* addresses, or
//! the two apps would sign differently — funds lost. This crate lets both
//! platforms run identical code, byte for byte. The derivation is pinned to the
//! cross-platform golden vector in `tests/fixtures/hd-derivation-golden.json`.
//!
//! Network I/O (fetching the account sequence, deciding create-account, fetching
//! the minimum reserve, broadcasting) stays in the platform code; this core is
//! pure and deterministic so it can be golden-tested offline.
//!
//! Safety semantics carried over verbatim from the apps (do not weaken):
//! - **C-1**: a numeric exchange memo is encoded as `MEMO_ID` (uint64), never
//!   silently downgraded to text; malformed id/hash fails closed.
//! - **H-3**: muxed `M…` destinations are rejected with a clear message (this
//!   build does not yet encode `KEY_TYPE_MUXED_ED25519`).
//! - **M-3**: signing refuses if a recognized Horizon host contradicts the
//!   declared network (mainnet vs testnet).

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer, SigningKey, Verifier};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256, Sha512};
use stellar_strkey::ed25519::PublicKey as StrkeyPublic;
use stellar_xdr::{
    AccountId, Asset, BytesM, CreateAccountOp, DecoratedSignature, Hash, Limits, Memo,
    MuxedAccount, Operation, OperationBody, PaymentOp, Preconditions, PublicKey as XdrPublicKey,
    SequenceNumber, Signature as XdrSignature, SignatureHint, Transaction,
    TransactionEnvelope, TransactionExt, TransactionSignaturePayload,
    TransactionSignaturePayloadTaggedTransaction, TransactionV1Envelope, Uint256, WriteXdr,
};

// Wires up the UniFFI scaffolding for every `#[uniffi::export]` item below.
uniffi::setup_scaffolding!();

type HmacSha512 = Hmac<Sha512>;

/// BIP-39 mnemonic word counts accepted on import (matches both apps).
pub const SUPPORTED_WORD_COUNTS: [usize; 5] = [12, 15, 18, 21, 24];
/// Word count used for newly generated wallets (matches both apps).
pub const DEFAULT_WORD_COUNT: usize = 24;
/// SLIP-44 coin type for Stellar (SEP-0005).
pub const STELLAR_COIN_TYPE: u32 = 148;
/// Network passphrases (the bytes hashed into the signature base).
pub const STELLAR_TESTNET_PASSPHRASE: &str = "Test SDF Network ; September 2015";
pub const STELLAR_PUBLIC_PASSPHRASE: &str = "Public Global Stellar Network ; September 2015";

/// H-3: shown when a recipient hands over a muxed (`M…`) address.
pub const MUXED_UNSUPPORTED_MESSAGE: &str = "This is a muxed Stellar address (it starts with \"M\"). VelarumPay does not support muxed addresses yet — ask the recipient for their standard \"G...\" address (plus a memo / ID if this is an exchange or custodial deposit).";

/// Errors returned by the core. The platform adapters map these to the existing
/// user-facing messages so behaviour (and localisation) is unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalletError {
    /// Word count is not one of 12/15/18/21/24.
    InvalidWordCount(usize),
    /// Mnemonic failed BIP-39 validation (unknown word or bad checksum).
    InvalidMnemonic(String),
    /// XLM amount string was malformed or non-positive.
    InvalidAmount(String),
    /// Destination address was malformed or unsupported (e.g. muxed, H-3).
    InvalidDestination(String),
    /// Memo was malformed for its declared type (C-1, fail closed).
    InvalidMemo(String),
    /// Declared network contradicts the Horizon host (M-3).
    NetworkMismatch(String),
    /// XDR/crypto failure that should not happen for valid inputs.
    Internal(String),
}

impl std::fmt::Display for WalletError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WalletError::InvalidWordCount(n) => write!(
                f,
                "Recovery phrase must be 12, 15, 18, 21, or 24 words (got {n})."
            ),
            WalletError::InvalidMnemonic(m)
            | WalletError::InvalidAmount(m)
            | WalletError::InvalidDestination(m)
            | WalletError::InvalidMemo(m)
            | WalletError::NetworkMismatch(m)
            | WalletError::Internal(m) => write!(f, "{m}"),
        }
    }
}
impl std::error::Error for WalletError {}

fn xdr_internal(e: stellar_xdr::Error) -> WalletError {
    WalletError::Internal(format!("Stellar XDR error: {e}"))
}

// ---------------------------------------------------------------------------
// Derivation (Phase 1, milestone 1)
// ---------------------------------------------------------------------------

/// Derived Stellar account material for a single derivation path.
#[derive(Debug, Clone)]
pub struct StellarKeys {
    /// Strkey public address, e.g. `GB3J…QBYX`.
    pub address: String,
    /// 32-byte ed25519 public key.
    pub public_key: [u8; 32],
    /// 32-byte ed25519 secret seed (the SLIP-0010 derived key).
    pub secret_seed: [u8; 32],
    /// SEP-0005 derivation path actually used, e.g. `m/44'/148'/0'`.
    pub derivation_path: String,
}

/// Normalize a mnemonic exactly like both apps: collapse all whitespace to
/// single spaces and lowercase every word.
fn normalize_mnemonic(mnemonic: &str) -> String {
    mnemonic
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Derive the Stellar account at `m/44'/148'/account'` from a BIP-39 mnemonic.
///
/// `passphrase` is the BIP-39 passphrase (empty string for VelarumPay wallets).
pub fn derive_stellar(
    mnemonic: &str,
    passphrase: &str,
    account: u32,
) -> Result<StellarKeys, WalletError> {
    let phrase = normalize_mnemonic(mnemonic);
    let count = phrase.split(' ').filter(|w| !w.is_empty()).count();
    if !SUPPORTED_WORD_COUNTS.contains(&count) {
        return Err(WalletError::InvalidWordCount(count));
    }
    // BIP-39 validation (wordlist + checksum) and the PBKDF2-HMAC-SHA512 seed.
    let parsed = bip39::Mnemonic::parse_in_normalized(bip39::Language::English, &phrase)
        .map_err(|e| WalletError::InvalidMnemonic(format!("{e}")))?;
    let seed = parsed.to_seed(passphrase);

    let secret_seed = slip10_ed25519(&seed, &[44, STELLAR_COIN_TYPE, account]);
    let signing = SigningKey::from_bytes(&secret_seed);
    let public_key = signing.verifying_key().to_bytes();
    // stellar-strkey's `to_string()` returns a no_std `heapless::String`; convert
    // to a std `String` for the FFI-friendly result type.
    let address = StrkeyPublic(public_key).to_string().as_str().to_owned();

    Ok(StellarKeys {
        address,
        public_key,
        secret_seed,
        derivation_path: format!("m/44'/{STELLAR_COIN_TYPE}'/{account}'"),
    })
}

/// SLIP-0010 ed25519 derivation (hardened-only), mirroring the existing
/// Android (`HDWallet.deriveSlip10`) and iOS (`slip10Ed25519Seed`) code.
fn slip10_ed25519(seed: &[u8], path: &[u32]) -> [u8; 32] {
    let i = hmac_sha512(b"ed25519 seed", seed);
    let mut key = [0u8; 32];
    let mut chain = [0u8; 32];
    key.copy_from_slice(&i[0..32]);
    chain.copy_from_slice(&i[32..64]);
    for &child in path {
        let hardened = child | 0x8000_0000;
        let mut data = Vec::with_capacity(37);
        data.push(0u8);
        data.extend_from_slice(&key);
        data.extend_from_slice(&hardened.to_be_bytes());
        let i = hmac_sha512(&chain, &data);
        key.copy_from_slice(&i[0..32]);
        chain.copy_from_slice(&i[32..64]);
    }
    key
}

fn hmac_sha512(key: &[u8], data: &[u8]) -> [u8; 64] {
    let mut mac = HmacSha512::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    let bytes = mac.finalize().into_bytes();
    let mut out = [0u8; 64];
    out.copy_from_slice(&bytes);
    out
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(bytes);
    let out = h.finalize();
    let mut a = [0u8; 32];
    a.copy_from_slice(&out);
    a
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

// ---------------------------------------------------------------------------
// Signing (Phase 1, milestone 2)
// ---------------------------------------------------------------------------

/// A locally built, signed Stellar transaction envelope, ready to broadcast.
#[derive(Debug, Clone)]
pub struct SignedStellarTransaction {
    /// Base64-encoded `TransactionEnvelope` XDR to POST to Horizon.
    pub envelope_base64: String,
    /// Lowercase-hex transaction hash.
    pub tx_hash_hex: String,
    /// Whether this is a Create Account (recipient not yet activated).
    pub create_account: bool,
}

/// Parse an XLM amount string into stroops (1 XLM = 10,000,000 stroops) using
/// exact integer math — never floating point. Mirrors the apps' `xlmToStroops`.
pub fn xlm_to_stroops(amount: &str) -> Result<i64, WalletError> {
    let clean = amount.trim();
    let parts: Vec<&str> = clean.split('.').collect();
    if parts.is_empty() || parts.len() > 2 {
        return Err(WalletError::InvalidAmount("Invalid XLM amount.".into()));
    }
    let whole: i64 = parts[0]
        .parse()
        .map_err(|_| WalletError::InvalidAmount("Invalid XLM amount.".into()))?;
    let frac = if parts.len() == 2 { parts[1] } else { "" };
    if frac.len() > 7 || !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err(WalletError::InvalidAmount(
            "XLM supports at most 7 decimal places.".into(),
        ));
    }
    let mut padded = String::from(frac);
    while padded.len() < 7 {
        padded.push('0');
    }
    let stroop_frac: i64 = padded
        .parse()
        .map_err(|_| WalletError::InvalidAmount("Invalid XLM amount.".into()))?;
    let amount = whole
        .checked_mul(10_000_000)
        .and_then(|w| w.checked_add(stroop_frac))
        .ok_or_else(|| WalletError::InvalidAmount("Invalid XLM amount.".into()))?;
    if amount <= 0 {
        return Err(WalletError::InvalidAmount(
            "XLM amount must be greater than zero.".into(),
        ));
    }
    Ok(amount)
}

/// M-3: refuse to sign if a *recognized* Horizon host contradicts the declared
/// network. Unrecognized custom hosts are allowed through on the declared flag.
pub fn assert_stellar_network_consistency(host: &str, testnet: bool) -> Result<(), WalletError> {
    let host = host.to_lowercase();
    let host_is_testnet = host.contains("testnet");
    let host_is_mainnet = host == "horizon.stellar.org" || host.ends_with(".horizon.stellar.org");
    if host_is_testnet && !testnet {
        return Err(WalletError::NetworkMismatch(format!(
            "Network mismatch: this request is labeled Stellar mainnet, but its Horizon endpoint is testnet ({host}). Refusing to sign."
        )));
    }
    if host_is_mainnet && testnet {
        return Err(WalletError::NetworkMismatch(format!(
            "Network mismatch: this request is labeled Stellar testnet, but its Horizon endpoint is mainnet ({host}). Refusing to sign."
        )));
    }
    Ok(())
}

/// Decode a destination address to a 32-byte ed25519 public key, rejecting muxed
/// `M…` addresses up front (H-3).
fn decode_destination(addr: &str) -> Result<[u8; 32], WalletError> {
    let trimmed = addr.trim();
    if trimmed.to_uppercase().starts_with('M') {
        return Err(WalletError::InvalidDestination(MUXED_UNSUPPORTED_MESSAGE.into()));
    }
    let pk = StrkeyPublic::from_string(trimmed)
        .map_err(|_| WalletError::InvalidDestination("Invalid Stellar public address.".into()))?;
    Ok(pk.0)
}

/// Decode a MEMO_HASH / MEMO_RETURN value (exactly 32 bytes) from 64 hex chars or
/// base64. Mirrors the apps' `stellarMemoHash32`.
fn decode_memo_hash32(value: &str) -> Option<[u8; 32]> {
    let t = value.trim();
    if t.len() == 64 {
        if let Some(b) = hex_to_bytes(t) {
            if b.len() == 32 {
                let mut a = [0u8; 32];
                a.copy_from_slice(&b);
                return Some(a);
            }
        }
    }
    if let Ok(b) = STANDARD.decode(t) {
        if b.len() == 32 {
            let mut a = [0u8; 32];
            a.copy_from_slice(&b);
            return Some(a);
        }
    }
    None
}

fn hex_to_bytes(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
        i += 2;
    }
    Some(out)
}

/// Build a Stellar `Memo`, honouring the declared type and failing closed on a
/// malformed id/hash (C-1). An empty memo is always `MEMO_NONE`.
fn build_memo(memo: &str, memo_type: &str) -> Result<Memo, WalletError> {
    let text = memo.trim();
    if text.is_empty() {
        return Ok(Memo::None);
    }
    match memo_type.trim().to_lowercase().as_str() {
        "" | "text" => {
            let len = text.as_bytes().len();
            if len > 28 {
                return Err(WalletError::InvalidMemo(format!(
                    "Stellar text memo must be 28 bytes or fewer (this one is {len}). Shorten it, or confirm the exchange wants a numeric ID memo instead."
                )));
            }
            let s = stellar_xdr::StringM::<28>::try_from(text)
                .map_err(|_| WalletError::InvalidMemo("Invalid Stellar text memo.".into()))?;
            Ok(Memo::Text(s))
        }
        "id" => {
            let id: u64 = text.parse().map_err(|_| {
                WalletError::InvalidMemo(format!(
                    "Stellar numeric memo (MEMO_ID) must be a whole number from 0 to 18446744073709551615. Got \"{text}\"."
                ))
            })?;
            Ok(Memo::Id(id))
        }
        "hash" | "return" => {
            let kind = memo_type.trim().to_lowercase();
            let hash = decode_memo_hash32(text).ok_or_else(|| {
                WalletError::InvalidMemo(format!(
                    "Stellar {kind} memo must be exactly 32 bytes, encoded as 64 hex characters or base64."
                ))
            })?;
            if kind == "hash" {
                Ok(Memo::Hash(Hash(hash)))
            } else {
                Ok(Memo::Return(Hash(hash)))
            }
        }
        _ => Err(WalletError::InvalidMemo(format!(
            "Unsupported Stellar memo type \"{}\". Use \"text\", \"id\", \"hash\", or \"return\".",
            memo_type.trim()
        ))),
    }
}

/// Build and sign a Stellar payment (or create-account) transaction.
///
/// Pure and deterministic: the caller supplies the already-resolved `sequence`
/// (account sequence + 1), whether the recipient needs `create_account`, and the
/// network passphrase. No network I/O happens here.
#[allow(clippy::too_many_arguments)]
pub fn sign_stellar_payment(
    secret_seed: &[u8; 32],
    network_passphrase: &str,
    sequence: i64,
    destination_address: &str,
    amount_xlm: &str,
    memo: &str,
    memo_type: &str,
    create_account: bool,
) -> Result<SignedStellarTransaction, WalletError> {
    let amount = xlm_to_stroops(amount_xlm)?;
    let dest = decode_destination(destination_address)?;
    let memo_x = build_memo(memo, memo_type)?;

    let signing = SigningKey::from_bytes(secret_seed);
    let source_public = signing.verifying_key().to_bytes();

    let body = if create_account {
        OperationBody::CreateAccount(CreateAccountOp {
            destination: AccountId(XdrPublicKey::PublicKeyTypeEd25519(Uint256(dest))),
            starting_balance: amount,
        })
    } else {
        OperationBody::Payment(PaymentOp {
            destination: MuxedAccount::Ed25519(Uint256(dest)),
            asset: Asset::Native,
            amount,
        })
    };
    let operation = Operation {
        source_account: None,
        body,
    };
    let tx = Transaction {
        source_account: MuxedAccount::Ed25519(Uint256(source_public)),
        fee: 100,
        seq_num: SequenceNumber(sequence),
        cond: Preconditions::None,
        memo: memo_x,
        operations: vec![operation].try_into().expect("exactly one operation fits"),
        ext: TransactionExt::V0,
    };

    // Signature base = SHA256( network_id || ENVELOPE_TYPE_TX || tx ), exactly as
    // the apps compute it (TransactionSignaturePayload is the canonical form).
    let network_id = Hash(sha256(network_passphrase.as_bytes()));
    let payload = TransactionSignaturePayload {
        network_id,
        tagged_transaction: TransactionSignaturePayloadTaggedTransaction::Tx(tx.clone()),
    };
    let tx_hash = sha256(&payload.to_xdr(Limits::none()).map_err(xdr_internal)?);

    let signature = signing.sign(&tx_hash);
    // Defence in depth: never emit a signature that does not verify.
    signing
        .verifying_key()
        .verify(&tx_hash, &signature)
        .map_err(|_| WalletError::Internal("Produced signature failed self-verification.".into()))?;

    let hint = SignatureHint([
        source_public[28],
        source_public[29],
        source_public[30],
        source_public[31],
    ]);
    let sig_xdr = XdrSignature(
        BytesM::<64>::try_from(&signature.to_bytes()[..]).map_err(xdr_internal)?,
    );
    let decorated = DecoratedSignature {
        hint,
        signature: sig_xdr,
    };
    let envelope = TransactionEnvelope::Tx(TransactionV1Envelope {
        tx,
        signatures: vec![decorated].try_into().expect("exactly one signature fits"),
    });
    let envelope_base64 = envelope.to_xdr_base64(Limits::none()).map_err(xdr_internal)?;

    Ok(SignedStellarTransaction {
        envelope_base64,
        tx_hash_hex: to_hex(&tx_hash),
        create_account,
    })
}

// ---------------------------------------------------------------------------
// UniFFI layer — exactly what Kotlin (Android) and Swift (iOS) call. Kept as a
// thin wrapper of FFI-friendly types (Vec<u8>, String) so the pure core API
// above stays clean and independently testable.
// ---------------------------------------------------------------------------

/// FFI mirror of [`StellarKeys`] (fixed-size arrays become byte vectors).
#[derive(Debug, uniffi::Record)]
pub struct FfiStellarKeys {
    pub address: String,
    pub public_key: Vec<u8>,
    pub secret_seed: Vec<u8>,
    pub derivation_path: String,
}

/// FFI mirror of [`SignedStellarTransaction`].
#[derive(Debug, uniffi::Record)]
pub struct FfiSignedStellarTransaction {
    pub envelope_base64: String,
    pub tx_hash_hex: String,
    pub create_account: bool,
}

/// Flat error carried across the FFI boundary. The platform adapters surface
/// `message` to the user — it is the same English text the apps already show.
#[derive(Debug, uniffi::Error)]
pub enum FfiWalletError {
    Message(String),
}

impl std::fmt::Display for FfiWalletError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FfiWalletError::Message(m) => write!(f, "{m}"),
        }
    }
}

impl From<WalletError> for FfiWalletError {
    fn from(e: WalletError) -> Self {
        FfiWalletError::Message(e.to_string())
    }
}

/// Derive the Stellar account at `m/44'/148'/account'` from a mnemonic.
#[uniffi::export]
pub fn stellar_derive(
    mnemonic: String,
    passphrase: String,
    account: u32,
) -> Result<FfiStellarKeys, FfiWalletError> {
    let k = derive_stellar(&mnemonic, &passphrase, account)?;
    Ok(FfiStellarKeys {
        address: k.address,
        public_key: k.public_key.to_vec(),
        secret_seed: k.secret_seed.to_vec(),
        derivation_path: k.derivation_path,
    })
}

/// Build and sign a Stellar payment / create-account transaction.
#[uniffi::export]
pub fn stellar_sign_payment(
    secret_seed: Vec<u8>,
    network_passphrase: String,
    sequence: i64,
    destination_address: String,
    amount_xlm: String,
    memo: String,
    memo_type: String,
    create_account: bool,
) -> Result<FfiSignedStellarTransaction, FfiWalletError> {
    if secret_seed.len() != 32 {
        return Err(FfiWalletError::Message(
            "Stellar secret seed must be exactly 32 bytes.".into(),
        ));
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&secret_seed);
    let s = sign_stellar_payment(
        &seed,
        &network_passphrase,
        sequence,
        &destination_address,
        &amount_xlm,
        &memo,
        &memo_type,
        create_account,
    )?;
    Ok(FfiSignedStellarTransaction {
        envelope_base64: s.envelope_base64,
        tx_hash_hex: s.tx_hash_hex,
        create_account: s.create_account,
    })
}

/// Parse an XLM amount string into exact integer stroops.
#[uniffi::export]
pub fn stellar_xlm_to_stroops(amount: String) -> Result<i64, FfiWalletError> {
    Ok(xlm_to_stroops(&amount)?)
}

/// M-3: refuse if a recognized Horizon host contradicts the declared network.
#[uniffi::export]
pub fn stellar_assert_network_consistency(
    host: String,
    testnet: bool,
) -> Result<(), FfiWalletError> {
    assert_stellar_network_consistency(&host, testnet)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use stellar_xdr::ReadXdr; // for TransactionEnvelope::from_xdr_base64 in tests

    // The cross-platform golden vector (tests/fixtures/hd-derivation-golden.json).
    const GOLDEN_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const GOLDEN_ADDRESS: &str = "GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX";

    #[test]
    fn stellar_matches_cross_platform_golden_vector() {
        let keys = derive_stellar(GOLDEN_MNEMONIC, "", 0).unwrap();
        assert_eq!(keys.address, GOLDEN_ADDRESS, "Rust core drifted from golden vector");
        assert_eq!(keys.derivation_path, "m/44'/148'/0'");
        assert_eq!(keys.public_key.len(), 32);
        assert_eq!(keys.secret_seed.len(), 32);
    }

    #[test]
    fn rejects_unsupported_word_count() {
        let err = derive_stellar("abandon abandon about", "", 0).unwrap_err();
        assert_eq!(err, WalletError::InvalidWordCount(3));
    }

    #[test]
    fn normalizes_case_and_whitespace() {
        let messy = "  ABANDON   abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon  ABOUT ";
        let keys = derive_stellar(messy, "", 0).unwrap();
        assert_eq!(keys.address, GOLDEN_ADDRESS);
    }

    #[test]
    fn rejects_bad_checksum() {
        let bad = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
        assert!(matches!(derive_stellar(bad, "", 0), Err(WalletError::InvalidMnemonic(_))));
    }

    #[test]
    fn matches_independent_stellar_hd_wallet_vectors() {
        // Generated independently with the SEP-0005 reference `stellar-hd-wallet`
        // (npm) — the same tool that produced the canonical golden vector — so a
        // match here is third-party confirmation, not self-agreement.
        let cases = [
            (
                "legal winner thank year wave sausage worth useful legal winner thank yellow",
                "GAFOIIMIXWLSN66RYL32JHCI7AMKWZ3TYYSZTOXSTLPHJWPMZDERMXUO",
            ),
            (
                "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
                "GBBWHEZC4L5ATI7RHDC7QEY5MMY7Z7BJUNA5VEI67GLGZQLBR3HJPKQI",
            ),
            (
                "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
                "GB3TCCIC6KLYKM72PX7KA6RNYC2BHC7DQYDMEAAN7PDMUZQD7UKJGSSY",
            ),
        ];
        for (mnemonic, expected) in cases {
            assert_eq!(
                derive_stellar(mnemonic, "", 0).unwrap().address,
                expected,
                "core drifted on independent vector starting '{}'",
                mnemonic.split(' ').next().unwrap()
            );
        }
    }

    // ---- signing ----

    #[test]
    fn signs_canonical_payment_that_round_trips() {
        let keys = derive_stellar(GOLDEN_MNEMONIC, "", 0).unwrap();
        let signed = sign_stellar_payment(
            &keys.secret_seed,
            STELLAR_TESTNET_PASSPHRASE,
            12345,
            &keys.address, // send to self: a valid G... address
            "1.5",
            "",
            "",
            false,
        )
        .unwrap();

        // The produced envelope is canonical XDR and decodes to the intended tx.
        let env =
            TransactionEnvelope::from_xdr_base64(signed.envelope_base64.as_bytes(), Limits::none())
                .expect("envelope is canonical XDR");
        let v1 = match env {
            TransactionEnvelope::Tx(v) => v,
            _ => panic!("expected a v1 transaction envelope"),
        };
        assert_eq!(v1.tx.fee, 100);
        assert_eq!(v1.tx.seq_num.0, 12345);
        assert!(matches!(v1.tx.cond, Preconditions::None));
        assert!(matches!(v1.tx.memo, Memo::None));
        assert_eq!(signed.tx_hash_hex.len(), 64);
        assert!(!signed.create_account);
    }

    #[test]
    fn signing_is_deterministic() {
        let keys = derive_stellar(GOLDEN_MNEMONIC, "", 0).unwrap();
        let a = sign_stellar_payment(&keys.secret_seed, STELLAR_TESTNET_PASSPHRASE, 1, &keys.address, "2.5", "", "", false).unwrap();
        let b = sign_stellar_payment(&keys.secret_seed, STELLAR_TESTNET_PASSPHRASE, 1, &keys.address, "2.5", "", "", false).unwrap();
        assert_eq!(a.envelope_base64, b.envelope_base64);
        assert_eq!(a.tx_hash_hex, b.tx_hash_hex);
    }

    #[test]
    fn rejects_muxed_destination_h3() {
        let keys = derive_stellar(GOLDEN_MNEMONIC, "", 0).unwrap();
        let muxed = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";
        let err = sign_stellar_payment(&keys.secret_seed, STELLAR_TESTNET_PASSPHRASE, 1, muxed, "1", "", "", false).unwrap_err();
        assert!(matches!(err, WalletError::InvalidDestination(_)));
    }

    #[test]
    fn amount_parsing_is_exact() {
        assert_eq!(xlm_to_stroops("1.5").unwrap(), 15_000_000);
        assert_eq!(xlm_to_stroops("0.0000001").unwrap(), 1);
        assert_eq!(xlm_to_stroops("100").unwrap(), 1_000_000_000);
        assert!(xlm_to_stroops("1.12345678").is_err()); // > 7 decimals
        assert!(xlm_to_stroops("0").is_err()); // must be > 0
        assert!(xlm_to_stroops("abc").is_err());
    }

    #[test]
    fn network_consistency_m3() {
        assert!(assert_stellar_network_consistency("horizon-testnet.stellar.org", false).is_err());
        assert!(assert_stellar_network_consistency("horizon.stellar.org", true).is_err());
        assert!(assert_stellar_network_consistency("horizon.stellar.org", false).is_ok());
        assert!(assert_stellar_network_consistency("horizon-testnet.stellar.org", true).is_ok());
        assert!(assert_stellar_network_consistency("my-custom-horizon.example", true).is_ok());
    }

    #[test]
    fn memo_id_is_not_downgraded_to_text_c1() {
        let keys = derive_stellar(GOLDEN_MNEMONIC, "", 0).unwrap();
        let signed = sign_stellar_payment(&keys.secret_seed, STELLAR_TESTNET_PASSPHRASE, 7, &keys.address, "1", "100200300", "id", false).unwrap();
        let env = TransactionEnvelope::from_xdr_base64(signed.envelope_base64.as_bytes(), Limits::none()).unwrap();
        let v1 = match env { TransactionEnvelope::Tx(v) => v, _ => panic!() };
        assert_eq!(v1.tx.memo, Memo::Id(100200300));
        // A non-numeric "id" memo must fail closed, not become text.
        assert!(sign_stellar_payment(&keys.secret_seed, STELLAR_TESTNET_PASSPHRASE, 7, &keys.address, "1", "not-a-number", "id", false).is_err());
    }
}
