//! Soroban resource benchmark harness for the token-factory contract.
//!
//! Measures CPU instructions and memory bytes consumed by each entrypoint
//! using the Soroban test environment's built-in cost metering
//! (`env.cost_estimate().resources()`).  `Env::default()` already enables
//! invocation metering automatically in test builds, so no extra setup is
//! required.
//!
//! Run the benchmarks and emit a JSON report to stdout:
//!
//! ```bash
//! cd contracts/token-factory
//! cargo test --test bench -- --nocapture 2>/dev/null
//! ```
//!
//! Or run through the convenience wrapper that also writes the JSON file:
//!
//! ```bash
//! cd contracts/token-factory
//! cargo test bench_ -- --nocapture 2>/dev/null | \
//!   python3 ../../scripts/collect_benchmarks.py
//! ```
//!
//! The CI job in `.github/workflows/benchmarks.yml` runs this automatically
//! on every PR touching `contracts/` and compares the output against the
//! committed baseline in `bench_snapshots/baseline.json`.

extern crate std;
use std::{format, println};

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, BytesN, Env, String, Vec,
};

// ─── helpers ──────────────────────────────────────────────────────────────────

fn dummy_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

/// Captured resource numbers for a single entrypoint invocation.
#[derive(Debug, Clone)]
pub struct BenchResult {
    pub label: std::string::String,
    pub cpu_insns: u64,
    pub mem_bytes: u64,
    pub ledger_reads: u32,
    pub ledger_writes: u32,
}

impl BenchResult {
    /// Emit as a single-line JSON object.  The CI script greps these lines
    /// to assemble the full report.
    pub fn print_json(&self) {
        println!(
            "BENCH_RESULT: {{\"label\":\"{}\",\"cpu_insns\":{},\"mem_bytes\":{},\"ledger_reads\":{},\"ledger_writes\":{}}}",
            self.label,
            self.cpu_insns,
            self.mem_bytes,
            self.ledger_reads,
            self.ledger_writes,
        );
    }
}

/// Collect resource costs from the most recent top-level invocation.
fn capture(env: &Env, label: impl Into<std::string::String>) -> BenchResult {
    let res = env.cost_estimate().resources();
    BenchResult {
        label: label.into(),
        cpu_insns: res.instructions as u64,
        mem_bytes: res.mem_bytes as u64,
        ledger_reads: res.disk_read_entries,
        ledger_writes: res.write_entries,
    }
}

// ─── shared setup ─────────────────────────────────────────────────────────────

struct BenchSetup {
    env: Env,
    contract_id: Address,
    admin: Address,
    treasury: Address,
    fee_token: Address,
    creator: Address,
}

impl BenchSetup {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        // Disable the default mainnet resource-limit enforcement so that
        // multi-token batches aren't killed by the limits we're measuring.
        env.cost_estimate().disable_resource_limits();

        let contract_id = env.register_contract(None, TokenFactory);
        let client: TokenFactoryClient = TokenFactoryClient::new(&env, &contract_id);
        // SAFETY: identical lifetime extension used throughout test.rs in this workspace.
        let client: TokenFactoryClient<'static> = unsafe { core::mem::transmute(client) };

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let fee_token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let creator = Address::generate(&env);

        // Fund creator with enough fee tokens.
        StellarAssetClient::new(&env, &fee_token).mint(&creator, &10_000_000);

        client.__constructor(
            &admin,
            &treasury,
            &fee_token,
            &dummy_hash(&env),
            &1_000,
            &500,
        );

        // Avoid 0-timestamp on ledger entries for more realistic conditions.
        env.ledger().with_mut(|li| {
            li.timestamp = 1_700_000_000;
        });

        BenchSetup {
            env,
            contract_id,
            admin,
            treasury,
            fee_token,
            creator,
        }
    }

    fn client(&self) -> TokenFactoryClient<'_> {
        TokenFactoryClient::new(&self.env, &self.contract_id)
    }

    fn salt(&self, n: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[n; 32])
    }

    fn str(&self, s: &str) -> String {
        String::from_str(&self.env, s)
    }

    /// Create one token via `create_token` and return its address.
    fn create_one_token(&self, salt_byte: u8) -> Address {
        self.client().create_token(
            &self.creator,
            &self.salt(salt_byte),
            &self.str("TestToken"),
            &self.str("TST"),
            &7,
            &1_000_000u128,
            &1_000,
        )
    }

    /// Build a `Vec<BatchTokenParams>` of `n` entries.
    fn batch_params(&self, n: u8) -> Vec<BatchTokenParams> {
        let mut tokens: Vec<BatchTokenParams> = soroban_sdk::vec![&self.env];
        for i in 0..n {
            // Each token needs a unique salt so they deploy to different addresses.
            let mut salt_bytes = [0u8; 32];
            salt_bytes[0] = i.wrapping_add(1);
            salt_bytes[1] = 0xBE; // batch marker to avoid collisions with single-token tests
            let salt = BytesN::from_array(&self.env, &salt_bytes);

            let name = format!("Batch{}", i);
            let sym = format!("B{}", i);

            tokens.push_back(BatchTokenParams {
                salt,
                name: String::from_str(&self.env, &name),
                symbol: String::from_str(&self.env, &sym),
                decimals: 7,
                initial_supply: 1_000_000,
                max_supply: None,
            });
        }
        tokens
    }
}

// ─── benchmarks ───────────────────────────────────────────────────────────────

/// Benchmark `create_token` (single-token path).
#[test]
fn bench_create_token() {
    let s = BenchSetup::new();
    let result = s.client().try_create_token(
        &s.creator,
        &s.salt(1),
        &s.str("BenchToken"),
        &s.str("BNK"),
        &7,
        &500_000u128,
        &1_000,
    );
    assert!(result.is_ok(), "bench_create_token failed: {:?}", result);

    let r = capture(&s.env, "create_token");
    r.print_json();

    // Ensure the numbers are non-trivial (sanity check that metering is active).
    assert!(r.cpu_insns > 0, "CPU instructions should be non-zero");
    assert!(r.mem_bytes > 0, "memory bytes should be non-zero");
}

/// Benchmark `create_tokens_batch` at batch size = 1.
#[test]
fn bench_create_tokens_batch_1() {
    let s = BenchSetup::new();
    let params = s.batch_params(1);
    let result = s
        .client()
        .try_create_tokens_batch(&s.creator, &params, &1_000);
    assert!(
        result.is_ok(),
        "bench_create_tokens_batch_1 failed: {:?}",
        result
    );

    let r = capture(&s.env, "create_tokens_batch_1");
    r.print_json();
    assert!(r.cpu_insns > 0);
}

/// Benchmark `create_tokens_batch` at batch size = 5.
#[test]
fn bench_create_tokens_batch_5() {
    let s = BenchSetup::new();
    let params = s.batch_params(5);
    let result = s
        .client()
        .try_create_tokens_batch(&s.creator, &params, &5_000);
    assert!(
        result.is_ok(),
        "bench_create_tokens_batch_5 failed: {:?}",
        result
    );

    let r = capture(&s.env, "create_tokens_batch_5");
    r.print_json();
    assert!(r.cpu_insns > 0);
}

/// Benchmark `create_tokens_batch` at batch size = 10.
#[test]
fn bench_create_tokens_batch_10() {
    let s = BenchSetup::new();
    let params = s.batch_params(10);
    let result = s
        .client()
        .try_create_tokens_batch(&s.creator, &params, &10_000);
    assert!(
        result.is_ok(),
        "bench_create_tokens_batch_10 failed: {:?}",
        result
    );

    let r = capture(&s.env, "create_tokens_batch_10");
    r.print_json();
    assert!(r.cpu_insns > 0);
}

/// Benchmark `create_tokens_batch` at batch size = 15.
#[test]
fn bench_create_tokens_batch_15() {
    let s = BenchSetup::new();
    let params = s.batch_params(15);
    let result = s
        .client()
        .try_create_tokens_batch(&s.creator, &params, &15_000);
    assert!(
        result.is_ok(),
        "bench_create_tokens_batch_15 failed: {:?}",
        result
    );

    let r = capture(&s.env, "create_tokens_batch_15");
    r.print_json();
    assert!(r.cpu_insns > 0);
}

/// Benchmark `create_tokens_batch` at batch size = 20.
#[test]
fn bench_create_tokens_batch_20() {
    let s = BenchSetup::new();
    let params = s.batch_params(20);
    let result = s
        .client()
        .try_create_tokens_batch(&s.creator, &params, &20_000);
    assert!(
        result.is_ok(),
        "bench_create_tokens_batch_20 failed: {:?}",
        result
    );

    let r = capture(&s.env, "create_tokens_batch_20");
    r.print_json();
    assert!(r.cpu_insns > 0);
}

/// Benchmark `create_tokens_batch` at batch size = 25.
///
/// At this size we expect to approach or exceed the mainnet `write_entries`
/// limit (50) and `disk_read_entries` limit (100).  The benchmark itself
/// doesn't fail the test — the CI comparison script flags regressions.
#[test]
fn bench_create_tokens_batch_25() {
    let s = BenchSetup::new();
    let params = s.batch_params(25);
    let result = s
        .client()
        .try_create_tokens_batch(&s.creator, &params, &25_000);
    assert!(
        result.is_ok(),
        "bench_create_tokens_batch_25 failed: {:?}",
        result
    );

    let r = capture(&s.env, "create_tokens_batch_25");
    r.print_json();
    assert!(r.cpu_insns > 0);
}

/// Benchmark `mint_tokens`.
#[test]
fn bench_mint_tokens() {
    let s = BenchSetup::new();
    // First create a token to mint into.
    let token_addr = s.create_one_token(0xAA);

    // Now benchmark the mint call.
    let result = s.client().try_mint_tokens(
        &token_addr,
        &s.creator,
        &s.creator,
        &500_000,
        &1_000, // base_fee
    );
    assert!(result.is_ok(), "bench_mint_tokens failed: {:?}", result);

    let r = capture(&s.env, "mint_tokens");
    r.print_json();
    assert!(r.cpu_insns > 0);
}

/// Benchmark `burn`.
#[test]
fn bench_burn() {
    let s = BenchSetup::new();
    let token_addr = s.create_one_token(0xBB);

    // Burn half the initial supply.
    let result = s.client().try_burn(&token_addr, &s.creator, &500_000);
    assert!(result.is_ok(), "bench_burn failed: {:?}", result);

    let r = capture(&s.env, "burn");
    r.print_json();
    assert!(r.cpu_insns > 0);
}

/// Benchmark `set_metadata`.
#[test]
fn bench_set_metadata() {
    let s = BenchSetup::new();
    let token_addr = s.create_one_token(0xCC);

    let uri = s.str("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
    let result = s
        .client()
        .try_set_metadata(&token_addr, &s.creator, &uri, &500);
    assert!(result.is_ok(), "bench_set_metadata failed: {:?}", result);

    let r = capture(&s.env, "set_metadata");
    r.print_json();
    assert!(r.cpu_insns > 0);
}

// ─── resource-limit sanity checks ─────────────────────────────────────────────

/// Verify that a single `create_token` stays comfortably below Soroban
/// mainnet per-transaction resource limits.  The margins below are 50 % of
/// the published mainnet limits, giving a large safety band in the native
/// test environment (which underestimates real WASM costs).
///
/// Mainnet limits (Protocol 21+):
///   CPU instructions: 600 000 000
///   Memory bytes:      41 943 040  (40 MB)
///   Ledger reads:             100
///   Ledger writes:             50
#[test]
fn bench_create_token_within_limits() {
    let s = BenchSetup::new();
    s.client().create_token(
        &s.creator,
        &s.salt(0xDD),
        &s.str("LimitCheck"),
        &s.str("LCK"),
        &7,
        &100_000u128,
        &1_000,
    );

    let res = s.env.cost_estimate().resources();
    // 50% of mainnet CPU limit
    assert!(
        res.instructions < 300_000_000,
        "create_token CPU ({}) exceeds 50% of mainnet limit (300M)",
        res.instructions
    );
    // 50% of mainnet mem limit
    assert!(
        res.mem_bytes < 20_971_520,
        "create_token memory ({} bytes) exceeds 50% of mainnet limit (20 MB)",
        res.mem_bytes
    );
}
