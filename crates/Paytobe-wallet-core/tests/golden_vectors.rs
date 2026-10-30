//! Ties the Rust core to the SAME single source of truth both apps use:
//! `tests/fixtures/hd-derivation-golden.json` at the repo root. When that file
//! gains more vectors, this test automatically checks the core against every one
//! — no code change needed here. Covers all three chains (Stellar / EVM / Solana).

use std::path::PathBuf;
use Paytobe_wallet_core::{derive_evm, derive_solana, derive_stellar};

#[test]
fn core_matches_every_shared_golden_vector() {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../tests/fixtures/hd-derivation-golden.json");
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let json: serde_json::Value = serde_json::from_str(&raw).expect("golden json parses");

    let vectors = json["vectors"].as_array().expect("`vectors` is an array");
    assert!(!vectors.is_empty(), "expected at least one golden vector");

    for v in vectors {
        let mnemonic = v["mnemonic"].as_str().expect("mnemonic string");
        let short = mnemonic.split(' ').next().unwrap_or("");

        let stellar = v["stellar_address"]
            .as_str()
            .expect("stellar_address string");
        assert_eq!(
            derive_stellar(mnemonic, "", 0)
                .expect("derive stellar")
                .address,
            stellar,
            "Rust core drifted from the shared golden Stellar vector (mnemonic starts '{short}')"
        );

        let evm = v["evm_address"].as_str().expect("evm_address string");
        assert_eq!(
            derive_evm(mnemonic, "").expect("derive evm").address,
            evm,
            "Rust core drifted from the shared golden EVM vector (mnemonic starts '{short}')"
        );

        let solana = v["solana_address"].as_str().expect("solana_address string");
        assert_eq!(
            derive_solana(mnemonic, "").expect("derive solana").address,
            solana,
            "Rust core drifted from the shared golden Solana vector (mnemonic starts '{short}')"
        );
    }
}
