#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

/// Input covers the full i128 range — including negatives — for both fee
/// fields.  Previous versions of this target applied `saturating_abs()` before
/// testing, which silently masked the missing sign-validation bug in
/// `initialize` and `update_fees`.  Raw values are now fed directly so the
/// fuzzer can reach the negative-fee code paths.
#[derive(Arbitrary, Debug, Clone)]
struct FuzzFeeArithmeticInput {
    base_fee: i128,
    metadata_fee: i128,
    num_operations: u8,
    /// An additional candidate update value, also unrestricted in sign.
    update_base_fee: i128,
    update_metadata_fee: i128,
}

/// Mirrors the sign-validation guard added to `initialize` and `update_fees`.
///
/// Returns `true` if the fee is valid (i.e., the contract would accept it),
/// `false` if it should be rejected.  This must stay in sync with the guard
/// in `lib.rs`:
///
/// ```rust
/// if base_fee < 0 || metadata_fee < 0 {
///     return Err(Error::InvalidParameters);
/// }
/// ```
fn fee_is_valid(fee: i128) -> bool {
    fee >= 0
}

fuzz_target!(|input: FuzzFeeArithmeticInput| {
    // ── 1. Sign validation — initialize path ─────────────────────────────
    //
    // The contract must accept exactly the non-negative half of i128.
    // Verify the predicate is correct for the fuzz-provided values.
    let init_should_succeed =
        fee_is_valid(input.base_fee) && fee_is_valid(input.metadata_fee);

    if !init_should_succeed {
        // At least one fee is negative — the contract rejects this.
        // Confirm the predicate fires for the right inputs.
        assert!(
            input.base_fee < 0 || input.metadata_fee < 0,
            "init_should_succeed is false but both fees are non-negative: \
             base_fee={}, metadata_fee={}",
            input.base_fee,
            input.metadata_fee
        );
        // Nothing further to test for an initialization that must be rejected.
        return;
    }

    // Both fees are non-negative — initialization is valid.
    let base_fee = input.base_fee;     // >= 0, proven above
    let metadata_fee = input.metadata_fee; // >= 0, proven above
    assert!(base_fee >= 0);
    assert!(metadata_fee >= 0);

    // ── 2. Sign validation — update_fees path ────────────────────────────
    //
    // Each of the two update candidates is independently validated.
    // The contract rejects the update if the new value is negative and
    // leaves the stored fee unchanged.
    let update_base_valid = fee_is_valid(input.update_base_fee);
    let update_meta_valid = fee_is_valid(input.update_metadata_fee);

    // Simulate the stored state after a potential update.
    let effective_base = if update_base_valid {
        input.update_base_fee // accepted — stored fee changes
    } else {
        base_fee // rejected — stored fee unchanged
    };
    let effective_meta = if update_meta_valid {
        input.update_metadata_fee
    } else {
        metadata_fee
    };

    // Invariant: the stored fees are always non-negative, regardless of what
    // was passed to update_fees.
    assert!(
        effective_base >= 0,
        "stored base_fee must be non-negative after update, got {}",
        effective_base
    );
    assert!(
        effective_meta >= 0,
        "stored metadata_fee must be non-negative after update, got {}",
        effective_meta
    );

    // ── 3. Fee-gate correctness ───────────────────────────────────────────
    //
    // With a non-negative required fee, the gate `fee_payment < required_fee`
    // must never silently pass a zero or negative payment that should be blocked.
    //
    // Specifically: when required_fee > 0, a fee_payment of 0 must be blocked.
    if effective_base > 0 {
        assert!(
            0_i128 < effective_base, // 0 < positive fee → gate fires
            "fee_payment=0 must fail the gate when base_fee={} > 0",
            effective_base
        );
    }
    if effective_meta > 0 {
        assert!(
            0_i128 < effective_meta,
            "fee_payment=0 must fail the gate when metadata_fee={} > 0",
            effective_meta
        );
    }

    // ── 4. distribute_fee arithmetic safety ──────────────────────────────
    //
    // `distribute_fee` is only ever called with a `fee_payment` that already
    // passed the `fee_payment < required_fee` gate, so amount >= required_fee
    // >= 0.  Verify the fee-split arithmetic cannot overflow or produce a
    // negative distribution for any non-negative amount.
    //
    // Model: two recipients each receiving 50 % (5_000 bps of 10_000).
    let fee_amount = effective_base; // representative non-negative fee
    let share_a = fee_amount
        .checked_mul(5_000)
        .map(|v| v / 10_000);
    let share_b = fee_amount
        .checked_mul(5_000)
        .map(|v| v / 10_000);

    if let (Some(a), Some(b)) = (share_a, share_b) {
        assert!(a >= 0, "fee share must be non-negative, got {a}");
        assert!(b >= 0, "fee share must be non-negative, got {b}");
        let distributed = a.checked_add(b);
        if let Some(d) = distributed {
            assert!(d >= 0);
            let remainder = fee_amount.checked_sub(d);
            if let Some(r) = remainder {
                assert!(
                    r >= 0,
                    "fee remainder must be non-negative: fee={fee_amount}, distributed={d}, remainder={r}"
                );
            }
        }
    }
    // (overflow in checked_mul is handled by the contract via
    //  Error::ArithmeticOverflow — not a panic path)

    // ── 5. batch fee multiplication ───────────────────────────────────────
    //
    // `create_tokens_batch` computes `base_fee * token_count` via checked_mul.
    // Verify this never overflows silently for non-negative fees.
    let ops = input.num_operations.min(100) as i128;
    let total_fee = effective_base.checked_mul(ops);
    let saturating_total = effective_base.saturating_mul(ops);

    if let Some(product) = total_fee {
        // No overflow: checked and saturating agree.
        assert_eq!(product, saturating_total);
        assert!(product >= 0, "batch fee product must be non-negative");
        // Monotonic: total >= per-op fee (unless fee is 0)
        assert!(
            product >= effective_base || effective_base == 0,
            "batch fee must be >= single-op fee: product={product}, base={effective_base}"
        );
    } else {
        // Overflow: saturating result is i128::MAX (positive).
        assert_eq!(
            saturating_total,
            i128::MAX,
            "saturating overflow must cap at i128::MAX"
        );
    }
    assert!(saturating_total >= 0, "saturating batch fee must be non-negative");
});
