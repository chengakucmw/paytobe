// Thin binary that runs UniFFI's binding generator for this crate.
// Built only with `--features cli` (see Cargo.toml), so the shipped library
// never links the CLI/clap dependencies.
fn main() {
    uniffi::uniffi_bindgen_main()
}
