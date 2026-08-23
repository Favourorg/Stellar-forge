# ADR-009: Access-Control Documentation Drift Detection Strategy

**Status:** PROPOSED  
**Date:** 2026-08-22  
**Decision Maker:** Architect (SDD Lead)  
**Issue:** #1112 (Access-Control Documentation Drift Check)

---

## Context

The Stellar Forge token-factory contract defines critical access-control semantics:

- **Admin-only operations:** `__constructor`, `set_whitelist_enabled`, `add_to_whitelist`, `remove_from_whitelist`, `set_metadata`
- **Creator-authorized operations:** `create_token`, `create_tokens_batch` (with optional whitelist gate)
- **View operations:** `is_whitelisted` (public, no auth required)

These semantics are documented across three sources:

1. **Code source of truth:** `contracts/token-factory/src/lib.rs` (Rust contract logic)
2. **API specification:** `docs/contract-abi.md` (public ABI, function signatures)
3. **Security policy:** `SECURITY.md`, `README.md` (high-level access control claims)

**Problem:** If a developer updates `lib.rs` to add/remove authorization checks or modify whitelist logic, the documentation may drift out of sync. This creates:

- **UX friction:** Frontend builds incorrect assumptions about access gates
- **Security risk:** Miscommunication about which addresses can call which functions
- **Audit failure:** Discrepancies between claimed and actual access control

**Goal:** Implement an automated drift detection mechanism in CI that:

1. Extracts access-control patterns from `lib.rs` (Rust AST)
2. Compares against documented claims in ABI and security docs
3. Fails the PR build if divergence exceeds acceptable thresholds
4. Provides actionable error messages and remediation steps

---

## Decision

**Implement access-control drift detection via a new Bash script, `scripts/check-access-control-docs-drift.sh`.**

### Rationale

**Why Bash (vs. Node.js or Python)?**

- **Consistency with existing drift-check scripts:** The codebase already uses Bash for `check-abi-doc-drift.sh`, `check-validation-drift.sh`, and `check-event-topic-drift.sh`. Bash is the established lingua franca for this family of linters.
- **Simplicity:** Access-control patterns are lexically regular (e.g., `require_auth()`, `admin.require_auth()`, `require_whitelisted(...)`). Regex and `grep` suffice; no need for a full Rust parser.
- **Low friction:** Runs in CI and developer shells without additional dependencies (Bash, grep, sed are standard on Linux/macOS).
- **Shift-left security:** Fast feedback loop — runs before compilation, catches drift immediately.

**Why not a full Rust AST parser?**

- Overkill for the patterns we need to detect; adds build-time overhead.
- If the codebase graduates to more complex semantic checks in future (e.g., control flow analysis), a Rust tool can be introduced then.

**Why not integrate into existing `check-abi-doc-drift.sh`?**

- Separation of concerns: ABI drift checks function _names_ and _signatures_; access-control checks _authorization logic_. Mixing them reduces maintainability.
- Different validation rules: ABI drift uses `grep` to find function names; access-control drift uses pattern matching on authorization logic.

---

## Architecture & Design

### 1. **Lexical Pattern Extraction from lib.rs**

The script will use regex + sed/awk to extract access-control assertions from `lib.rs`:

#### Pattern 1: Admin-only gates

```rust
admin.require_auth();
if state.admin != admin { return Error::Forbidden; }
```

**Extracted:** Function name + claim: "admin-only"

#### Pattern 2: Creator authorization

```rust
creator.require_auth();
```

**Extracted:** Function name + claim: "requires caller auth"

#### Pattern 3: Whitelist gates

```rust
Self::require_whitelisted(&env, &state, &creator)?;
```

**Extracted:** Function name + claim: "whitelist gate (conditional on `state.whitelist_enabled`)"

#### Pattern 4: View-only (no auth)

```rust
pub fn is_whitelisted(env: Env, address: Address) -> bool {
    // No require_auth() call
}
```

**Extracted:** Function name + claim: "view (no auth required)"

### 2. **Documentation Assertion Extraction**

The script will scan `docs/contract-abi.md` and `SECURITY.md` to find documented claims:

#### Format in `docs/contract-abi.md`

```markdown
### `add_to_whitelist(admin, address)`

**Authorization:** Admin-only (`admin.require_auth()`).  
**Effect:** Adds `address` to the whitelist.
```

**Extraction rule:** Search for `**Authorization:**` or `**Access control:**` sections.

#### Format in `SECURITY.md`

```markdown
| Function           | Caller | Requirement                                                 |
| ------------------ | ------ | ----------------------------------------------------------- |
| `add_to_whitelist` | admin  | Signer must be the current admin                            |
| `create_token`     | any    | Caller must be whitelisted (if enabled) or always permitted |
```

**Extraction rule:** Parse security matrix tables.

### 3. **Correspondence Matrix (Single Source of Truth)**

Define a hardcoded matrix in the script mapping (function, entrypoint) → expected access-control claims:

```bash
# Associative array (function → expected claims)
declare -A EXPECTED_CONTROLS=(
  ["__constructor"]="admin.require_auth"
  ["add_to_whitelist"]="admin.require_auth | admin_check"
  ["remove_from_whitelist"]="admin.require_auth | admin_check"
  ["set_whitelist_enabled"]="admin.require_auth | admin_check"
  ["is_whitelisted"]="no_auth_required"
  ["create_token"]="creator.require_auth | optional_whitelist_gate"
  ["create_tokens_batch"]="creator.require_auth | optional_whitelist_gate"
  ["set_metadata"]="admin.require_auth"
  # ... additional functions
)
```

### 4. **Comparison & Reporting Logic**

1. **Extract actual patterns** from `lib.rs` for each public function.
2. **Extract documented claims** from `docs/contract-abi.md` and `SECURITY.md`.
3. **For each function:**
   - Compare actual pattern against `EXPECTED_CONTROLS[function_name]`.
   - Compare documented claims against expected claims.
   - Flag mismatches as errors or warnings.
4. **Exit code:** 0 (all consistent), 1 (critical drift), 2 (warnings only).

### 5. **Output Format**

GitHub Actions annotations for inline PR feedback:

```
::error::Access-control drift detected in create_token:
  Expected: creator.require_auth | optional_whitelist_gate
  Found in code: creator.require_auth (whitelist gate MISSING)
  Found in docs: "Caller must be whitelisted"

  Action: Add `Self::require_whitelisted(...)` to create_token or update SECURITY.md
```

---

## Consequences

### Positive

- **Security by default:** Drift detection runs on every PR; no human review bypasses it.
- **Clear accountability:** Developers see exactly where code and docs diverge.
- **Low maintenance:** Bash script fits the existing CI pattern; no new infra.
- **Shift-left:** Catches issues before merge, reducing incident risk.

### Negative (Mitigations)

- **False positives:** Regex patterns might miss edge cases (e.g., conditional auth). **Mitigation:** Define clear patterns, document exceptions in comments.
- **Regex brittleness:** Code formatting changes can break pattern matching. **Mitigation:** Write flexible regex, test against multiple coding styles.
- **Documentation overhead:** Developers must keep three sources in sync. **Mitigation:** Generate documentation from code annotations in a future phase (ADR-010).

---

## Implementation Phases

### Phase 2a: Script Foundation (Pending)

- [ ] Define pattern extraction rules in Bash.
- [ ] Build correspondence matrix (hardcoded in script).
- [ ] Implement comparison logic.

### Phase 2b: Documentation Ingestion (Pending)

- [ ] Parse `docs/contract-abi.md` for authorization blocks.
- [ ] Parse `SECURITY.md` for security matrix.
- [ ] Map claims to expected patterns.

### Phase 2c: CI Integration (Pending)

- [ ] Add GitHub Actions workflow step to call the script.
- [ ] Configure exit code handling (error vs. warning).
- [ ] Document in `CONTRIBUTING.md`.

### Phase 3: Validation (Pending)

- [ ] Test against live contract on testnet.
- [ ] Audit documentation for accuracy.
- [ ] Merge and celebrate.

---

## Related ADRs & Standards

- **ADR-005:** Analytics & Privacy Consent (no cross-dependency).
- **SOLID Principle:** Separation of Concerns — drift detection isolated from CI orchestration.
- **Clean Architecture:** Validation logic (pure functions) separate from I/O (file reads).

---

## Questions & Open Items

1. **Whitelist gate optionality:** Should `require_whitelisted(...)` be _required_ or _optional_ for `create_token`? The code shows it's conditional on `state.whitelist_enabled`, but the documentation must be explicit.
   - **Answer (from SECURITY.md): Caller must be whitelisted (if enabled) or always permitted.**
   - **Code reflects this:** Drift rule: `create_token` must contain `Self::require_whitelisted(...)`.

2. **Future: Authorization annotations:** If access control becomes more complex, introduce `#[access_control(...)]` Rust attributes to generate docs automatically. (See ADR-010, future.)

---

**Approved by:** Architect  
**Date:** 2026-08-22  
**Next Review:** After Phase 2c completion
