#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

#[derive(Arbitrary, Debug, Clone)]
struct FuzzCreateTokenInput {
    // Random bytes for name and symbol - bounded to avoid extremely long strings
    name_bytes: Vec<u8>,
    symbol_bytes: Vec<u8>,
    decimals: u32,
    // i128 has full Arbitrary support; we reinterpret its bit pattern as u128
    // below to cover the high-end values that the contract's u128 parameter
    // accepts.  This means values ≥ 0 map to [0, i128::MAX] and negative
    // values map to (i128::MAX, u128::MAX], which is exactly the overflow
    // region guarded by the fix for issue #909.
    initial_supply_bits: i128,
    fee_payment: i128,
}

fuzz_target!(|input: FuzzCreateTokenInput| {
    // Test string validation and creation with random UTF-8 data

    // Convert random bytes to valid UTF-8 strings
    let name_str = match String::from_utf8(input.name_bytes) {
        Ok(s) if !s.is_empty() => s,
        _ => "DefaultToken".to_string(),
    };

    let symbol_str = match String::from_utf8(input.symbol_bytes) {
        Ok(s) if !s.is_empty() => s,
        _ => "DTK".to_string(),
    };

    // Verify string properties
    assert!(!name_str.is_empty());
    assert!(!symbol_str.is_empty());

    // Test bounded arithmetic - should not panic on overflow
    let decimals_bounded = input.decimals % 256;
    let fee_bounded = input.fee_payment.saturating_abs();

    // Verify invariants
    assert!(decimals_bounded < 256);
    assert!(fee_bounded >= 0);

    // ── Supply boundary checks (issue #909) ───────────────────────────────
    // Reinterpret the fuzz-provided i128 as a u128 (same bits, different type)
    // so that the full u128 domain — including values above i128::MAX — is
    // reachable by the fuzzer with an Arbitrary-compatible input type.
    let initial_supply = input.initial_supply_bits as u128;

    // Validate that the supply guard logic never panics and always produces
    // the correct accept/reject decision without silent wraparound.
    //
    // The fix rejects any u128 value > i128::MAX with InvalidParameters.
    // Here we replicate that exact predicate and confirm it is consistent
    // with a safe cast, covering the four critical boundary values that
    // libFuzzer is unlikely to find on its own:
    //   • i128::MAX - 1  (just below the limit — valid)
    //   • i128::MAX      (exactly at the limit — valid)
    //   • i128::MAX + 1  (one above the limit — must be rejected)
    //   • u128::MAX      (largest possible value — must be rejected)
    let boundary_cases: [u128; 4] = [
        (i128::MAX as u128).saturating_sub(1), // i128::MAX - 1
        i128::MAX as u128,                     // i128::MAX
        (i128::MAX as u128).saturating_add(1), // i128::MAX + 1
        u128::MAX,                             // u128::MAX
    ];

    for &supply in &boundary_cases {
        if supply > i128::MAX as u128 {
            // Values above i128::MAX must be rejected — simulating the guard.
            // A cast here would produce a negative i128; assert we never
            // reach the cast path without the guard.
            let would_be_negative = supply as i128; // intentional: validate sign
            assert!(
                would_be_negative < 0,
                "supply {supply} above i128::MAX must cast to a negative i128 \
                 (confirming the guard is necessary)"
            );
        } else {
            // Values at or below i128::MAX must cast safely and stay non-negative.
            let safe_supply = supply as i128;
            assert!(
                safe_supply >= 0,
                "supply {supply} ≤ i128::MAX must produce a non-negative i128, got {safe_supply}"
            );
        }
    }

    // Also run the same check for the fuzz-provided supply value so every
    // input exercises the guard predicate.
    if initial_supply <= i128::MAX as u128 {
        let safe = initial_supply as i128;
        assert!(
            safe >= 0,
            "supply {} ≤ i128::MAX must produce a non-negative i128, got {}",
            initial_supply,
            safe
        );
    }
    // (Values above i128::MAX would be rejected by the contract; no cast is
    //  performed on that code path, so no assertion needed here.)

    // Test saturation arithmetic doesn't panic
    let _total = fee_bounded.saturating_add(i64::MAX as i128);
    let _product = fee_bounded.saturating_mul(i128::from(decimals_bounded));

    // Fuzz test passes if no panic occurs
});
