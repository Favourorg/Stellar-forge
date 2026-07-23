#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

/// A single split recipient: basis points (0–10_000).
#[derive(Arbitrary, Debug, Clone)]
struct FuzzSplitEntry {
    bps: u16, // raw; we'll normalize below
}

#[derive(Arbitrary, Debug, Clone)]
struct FuzzFeeArithmeticInput {
    base_fee: i128,
    metadata_fee: i128,
    num_operations: u8,
    /// Raw split entries (up to 10 after capping); bps values are normalized
    /// to sum to exactly 10_000 before being used.
    split_entries: Vec<FuzzSplitEntry>,
    /// Fee amount to distribute across the split.
    fee_amount: i128,
}

fuzz_target!(|input: FuzzFeeArithmeticInput| {
    // ── Basic fee arithmetic (original checks) ────────────────────────────
    let base_fee = input.base_fee.saturating_abs();
    let metadata_fee = input.metadata_fee.saturating_abs();

    let _total_fee = base_fee.saturating_add(metadata_fee);
    let _scaled_fee = base_fee.saturating_mul(i128::from(input.num_operations));
    let _multiplied = metadata_fee.saturating_mul(10);

    assert!(base_fee >= 0);
    assert!(metadata_fee >= 0);
    assert!(_total_fee >= base_fee);
    assert!(_total_fee >= metadata_fee);

    let operations = input.num_operations.min(100) as i128;
    let cumulative_fees = base_fee.saturating_mul(operations);
    assert!(cumulative_fees >= 0);
    assert!(cumulative_fees >= base_fee || base_fee == 0);

    // ── Multi-recipient largest-remainder split simulation ─────────────────
    // Cap recipients to MAX_FEE_SPLIT_RECIPIENTS (10).
    let max_recipients: usize = 10;
    let amount = input.fee_amount.saturating_abs();

    if amount == 0 {
        return;
    }

    // Build a valid bps slice: at most 10 entries, each bps > 0, sum == 10_000.
    let raw: Vec<u16> = input
        .split_entries
        .iter()
        .take(max_recipients)
        .map(|e| e.bps.max(1)) // reject 0-bps entries per contract rule
        .collect();

    if raw.is_empty() {
        return;
    }

    // Normalize to sum == 10_000 using integer scaling.
    let raw_sum: u64 = raw.iter().map(|&b| b as u64).sum();
    let bps_vec: Vec<u32> = raw
        .iter()
        .map(|&b| {
            let scaled = (b as u64 * 10_000) / raw_sum;
            scaled.max(1) as u32 // keep each entry positive after rounding
        })
        .collect();

    // Re-sum and adjust last entry to force exact 10_000.
    let actual_sum: u32 = bps_vec.iter().sum();
    let mut bps_final = bps_vec.clone();
    if actual_sum != 10_000 {
        if actual_sum < 10_000 {
            *bps_final.last_mut().unwrap() += 10_000 - actual_sum;
        } else {
            // Reduce last entry; if it would go to 0 skip.
            let excess = actual_sum - 10_000;
            if *bps_final.last().unwrap() > excess {
                *bps_final.last_mut().unwrap() -= excess;
            } else {
                return; // degenerate — skip
            }
        }
    }
    assert_eq!(bps_final.iter().sum::<u32>(), 10_000);
    assert!(bps_final.iter().all(|&b| b > 0));

    // ── Simulate largest-remainder distribution ────────────────────────────
    let mut floors: Vec<i128> = Vec::new();
    let mut fracs: Vec<i128> = Vec::new();
    let mut total_floor: i128 = 0;

    for &bps in &bps_final {
        let bps_i = bps as i128;
        let floor = match amount.checked_mul(bps_i) {
            Some(v) => v / 10_000,
            None => return, // overflow — skip
        };
        let frac = match amount.checked_mul(bps_i) {
            Some(v) => match v.checked_sub(floor.saturating_mul(10_000)) {
                Some(f) => f,
                None => return,
            },
            None => return,
        };
        total_floor = match total_floor.checked_add(floor) {
            Some(v) => v,
            None => return,
        };
        floors.push(floor);
        fracs.push(frac);
    }

    let mut remainder = match amount.checked_sub(total_floor) {
        Some(v) => v,
        None => return,
    };

    // Distribute remainder stroops to highest-frac entries.
    while remainder > 0 {
        let best = fracs
            .iter()
            .enumerate()
            .max_by_key(|&(_, &f)| f)
            .map(|(i, &f)| (i, f));
        match best {
            Some((idx, frac)) if frac > 0 => {
                floors[idx] = floors[idx].saturating_add(1);
                fracs[idx] = 0;
                remainder = remainder.saturating_sub(1);
            }
            _ => break,
        }
    }

    // ── Invariant checks ──────────────────────────────────────────────────
    let sum: i128 = floors.iter().sum::<i128>() + remainder;
    // Property: sum of all shares + any unassigned remainder == original amount.
    assert_eq!(
        sum, amount,
        "LR invariant: sum of shares + remainder must equal fee amount"
    );

    // Each recipient must receive >= floor(amount * bps / 10_000).
    for (&bps, &share) in bps_final.iter().zip(floors.iter()) {
        let min_floor = amount * bps as i128 / 10_000;
        assert!(
            share >= min_floor,
            "each recipient must get at least their floor share"
        );
    }

    // No share can exceed amount.
    for &share in &floors {
        assert!(share >= 0 && share <= amount);
    }
});
