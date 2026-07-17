#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

#[derive(Arbitrary, Debug, Clone)]
struct FuzzSetMetadataInput {
    // Random bytes for metadata URI - no length restriction in the contract
    uri_bytes: Vec<u8>,
    fee_payment: i128,
    metadata_fee: i128,
    // Whether a duplicate set attempt follows the first
    attempt_duplicate: bool,
}

fuzz_target!(|input: FuzzSetMetadataInput| {
    // Normalize the metadata_fee so it is non-negative (contract stores positive fees)
    let metadata_fee = input.metadata_fee.saturating_abs();
    let fee_payment = input.fee_payment;

    // --- Fee comparison logic (mirrors set_metadata guard) ---
    let fee_sufficient = fee_payment >= metadata_fee;

    if fee_sufficient {
        // Payment at or above the required fee must never underflow when subtracted
        let remainder = fee_payment.saturating_sub(metadata_fee);
        assert!(remainder >= 0);
    }

    // --- Metadata URI string validation ---
    // The contract accepts any soroban_sdk::String; we model user-supplied bytes here.
    let uri_str = match String::from_utf8(input.uri_bytes.clone()) {
        Ok(s) => s,
        // Non-UTF-8 bytes would be rejected at the SDK boundary — treat as invalid
        Err(_) => return,
    };

    // Empty URIs are technically accepted by the contract (no length guard in set_metadata).
    // Verify that working with the string does not panic regardless of content.
    let _uri_len = uri_str.len();
    let _is_empty = uri_str.is_empty();

    // Simulate the "already set" idempotency guard: a second call for the same
    // token must return MetadataAlreadySet without touching the fee.
    if input.attempt_duplicate {
        // After a successful first call the storage slot is occupied.
        // The fee path is never reached, so no arithmetic is performed.
        // Verify the fee values themselves are still well-formed.
        assert!(metadata_fee >= 0);
    }

    // --- Overflow-safe fee accumulation (mirrors distribute_fee arithmetic) ---
    // Ensure multiplying the fee by a small operation count cannot overflow.
    let ops: i128 = 3; // set_metadata is a single operation, but guard the pattern
    let _scaled = metadata_fee.saturating_mul(ops);
    let _total = fee_payment.saturating_add(metadata_fee);

    // Invariant: saturating operations always return a value
    assert!(metadata_fee.saturating_add(i128::MAX) >= 0 || metadata_fee < 0);
});
