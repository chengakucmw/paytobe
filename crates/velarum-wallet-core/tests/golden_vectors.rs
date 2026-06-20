//! Ties the Rust core to the SAME single source of truth both apps use:
//! `tests/fixtures/hd-derivation-golden.json` at the repo root. When that file
//! gains more Stellar vectors, this test automatically checks the core against
//! every one — no code change needed here.

use std::path::PathBuf;
use velarum_wallet_core::derive_stellar;

#[test]
fn core_matches_every_shared_golden_vector() {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../tests/fixtures/hd-derivation-golden.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let json: serde_json::Value = serde_json::from_str(&raw).expect("golden json parses");

    let vectors = json["vectors"].as_array().expect("`vectors` is an array");
    assert!(!vectors.is_empty(), "expected at least one golden vector");

    for v in vectors {
        let mnemonic = v["mnemonic"].as_str().expect("mnemonic string");
        let expected = v["stellar_address"].as_str().expect("stellar_address string");
        let got = derive_stellar(mnemonic, "", 0).expect("derive").address;
        assert_eq!(
            got,
            expected,
            "Rust core drifted from the shared golden vector (mnemonic starts '{}')",
            mnemonic.split(' ').next().unwrap_or("")
        );
    }
}
