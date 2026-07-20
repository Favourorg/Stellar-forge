# StellarForge Incident Response Runbook

> **Audience:** On-call team, protocol maintainers, anyone with admin key access.
>
> **Scope:** Compromised or lost admin key for the StellarForge token-factory contract on mainnet.
>
> **Status:** Active — review and re-approve after every mainnet deployment and after any change to admin key custody.

---

## Table of contents

1. [Threat model](#1-threat-model)
2. [How compromise would be detected](#2-how-compromise-would-be-detected)
3. [Authority and contacts](#3-authority-and-contacts)
4. [Immediate response (first five minutes)](#4-immediate-response-first-five-minutes)
5. [Short-term stabilisation (first hour)](#5-short-term-stabilisation-first-hour)
6. [Recovery (first 24 hours)](#6-recovery-first-24 hours)
7. [Break-glass recovery mechanism](#7-break-glass-recovery-mechanism)
8. [Post-incident steps](#8-post-incident-steps)
9. [Communication plan](#9-communication-plan)
10. [Tabletop exercise checklist](#10-tabletop-exercise-checklist)

---

## 1. Threat model

The factory contract's `admin` address is a single point of catastrophic trust. An attacker in possession of the admin key can:

| Action | Effect |
|---|---|
| `update_fees(admin, base_fee, metadata_fee)` | Set arbitrarily high fees to drain users who call the contract |
| `set_fee_split(admin, splits)` | Redirect collected fees to an attacker-controlled address |
| `upgrade(admin, new_wasm_hash)` | Replace the contract with arbitrary attacker code |
| `transfer_admin(admin, new_admin)` / `update_admin(admin, new_admin)` | Lock out the legitimate operator permanently |
| `pause(admin)` | Halt the factory, denying service to all token creators |

**Upgrade detection gap:** `upgrade` currently emits no on-chain event (see issue #9). Until event emission is added, detection of a malicious WASM swap requires active polling of the on-chain WASM hash. This runbook treats upgrade detection latency as high-risk and calls it out explicitly.

---

## 2. How compromise would be detected

Detection relies on multiple independent signals. Any single signal is enough to begin the response procedure.

### 2.1 Sentry error correlation (fastest for client-side anomalies)

All Sentry events captured during transaction lifecycles are tagged with `network`, `contractId`, and `functionName` (see issue #944). An unusual spike in:
- `functionName: deployToken` errors with `InsufficientFee` codes (fee manipulation)
- `functionName: pollTransaction` failures across many unrelated users

should trigger investigation of the admin state.

Set a Sentry alert rule:
- Filter: `network = mainnet`, `functionName = deployToken`, `code = InsufficientFee`
- Condition: event count > 3 in 5 minutes
- Action: page on-call channel immediately

### 2.2 On-chain event monitoring (authoritative)

Subscribe to factory contract events via Horizon's Server-Sent Events (SSE) endpoint:

```bash
curl -N "https://horizon.stellar.org/accounts/<FACTORY_CONTRACT>/operations?cursor=now"
```

Alert on:
- Any `adm_upd` event (admin transfer — extremely rare in normal operation)
- Any `fees` event with unusually large values
- Any `pause` event not preceded by a planned maintenance notice

### 2.3 WASM hash polling (required until issue #9 is resolved)

Until `upgrade` emits an event, poll the on-chain WASM hash at least once per hour via a monitoring script:

```bash
#!/usr/bin/env bash
# check-wasm-hash.sh — run this on a cron schedule (every 5 minutes on mainnet)
EXPECTED_HASH="<paste-the-deployed-wasm-hash-here>"
CURRENT_HASH=$(stellar contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --network mainnet \
  -- get_state | jq -r '.wasm_hash // empty')

if [ "$CURRENT_HASH" != "$EXPECTED_HASH" ]; then
  echo "ALERT: WASM hash changed from $EXPECTED_HASH to $CURRENT_HASH" | \
    curl -X POST -d @- "$ALERT_WEBHOOK_URL"
fi
```

Store `EXPECTED_HASH` after each intentional upgrade and update the script immediately.

### 2.4 User reports

Token creators reporting sudden fee increases or failed `create_token` calls with no contract-level change on your end are a strong indicator of fee manipulation.

---

## 3. Authority and contacts

Maintain a live copy of this table in a private team channel. Do not embed real names or personal contact details in this public document.

| Role | Responsibility | Contact |
|---|---|---|
| **Incident commander** | Declares the incident, coordinates all actions, is the single decision-maker | *See team contact list* |
| **Admin key custodian** | Has access to the hardware wallet / multisig device holding the admin key | *See team contact list* |
| **Break-glass custodian** | Has access to the backup admin (break-glass) account | *See team contact list* |
| **Communications lead** | Drafts and publishes user-facing notices | *See team contact list* |
| **Legal / compliance** | Advises on disclosure obligations | *See team contact list* |

Minimum team size for executing on-chain recovery: **two people** (incident commander + admin key custodian). Never execute admin-level transactions alone.

---

## 4. Immediate response (first five minutes)

### Step 1 — Confirm the compromise

Do not act on a single noisy signal. Cross-check two or more of the detection signals in section 2 before proceeding.

```bash
# 1. Check current admin address
stellar contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --network mainnet \
  -- get_state | jq '.admin'

# 2. Check current fees
stellar contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --network mainnet \
  -- get_base_fee

# 3. Check current WASM hash against known-good value
stellar contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --network mainnet \
  -- get_state | jq '.wasm_hash'
```

### Step 2 — Call the incident commander

Even if you are the admin key custodian, do not act alone. Call the incident commander first. If unreachable within 2 minutes, escalate to the next person in the authority chain.

### Step 3 — Attempt to pause the factory (if admin key is still operable)

If the admin key has not yet been used by the attacker to transfer admin rights away:

```bash
stellar contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --source "$ADMIN_SECRET_KEY" \
  --network mainnet \
  -- pause \
  --admin "$ADMIN_ADDRESS"
```

`pause` halts `create_token`, `create_tokens_batch`, `mint_tokens`, and `set_metadata`. It does **not** halt `burn`, so users can always recover their own balances. Fees already collected cannot be retrieved via this mechanism.

> ⚠️ **If the attacker has already called `transfer_admin`** to a new address, your `pause` call will fail with `Unauthorized`. Skip to step 4.

### Step 4 — Attempt to transfer admin to the break-glass address

If the admin key is still operable but you suspect imminent key-theft (e.g. private key was exposed in logs):

```bash
stellar contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --source "$ADMIN_SECRET_KEY" \
  --network mainnet \
  -- transfer_admin \
  --admin "$ADMIN_ADDRESS" \
  --new_admin "$BREAK_GLASS_ADDRESS"
```

This transfers control to the pre-agreed break-glass account (see [section 7](#7-break-glass-recovery-mechanism)), rendering the compromised key inoperative for any further admin actions.

### Step 5 — Post to the incident channel

Immediately post the following to the team's incident Slack/Discord channel:

```
🚨 INCIDENT DECLARED — StellarForge mainnet factory
Time: <UTC timestamp>
Incident commander: <name>
Suspected action: <fee manipulation | admin transfer | WASM upgrade | unknown>
Admin key status: <operable | compromised — transferred away | unknown>
Factory paused: yes / no / failed
Next action: <describe>
```

---

## 5. Short-term stabilisation (first hour)

### 5.1 If the factory was paused successfully

- Monitor Sentry and Horizon for continued anomalous transactions.
- Assess whether funds were drained via `set_fee_split` before the pause.
- **Do not unpause** until the admin key custody situation is fully resolved and a new admin address has been established.

### 5.2 If the attacker has already transferred admin rights

- The contract is now under attacker control.
- **Do not attempt to call contract functions with the old admin key** — the transactions will fail and may leak information about your response timing.
- Begin the break-glass procedure in [section 7](#7-break-glass-recovery-mechanism).
- Note: if the attacker calls `upgrade` with a malicious WASM, the contract code itself is replaced. Verify the WASM hash before trusting any contract return values.

### 5.3 Fee impact assessment

Determine whether users were overcharged:

```bash
# Look for fee events with unusually high values
stellar contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --network mainnet \
  -- get_base_fee
```

Compare against the last known legitimate value from the deployment log. Document all affected transactions for later user communication.

### 5.4 WASM integrity check

```bash
# Get the current on-chain WASM hash
CURRENT_HASH=$(stellar contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --network mainnet \
  -- get_state | jq -r '.wasm_hash')

# Compare against the known-good hash from the deployment log
echo "Deployed hash: $KNOWN_GOOD_HASH"
echo "On-chain hash: $CURRENT_HASH"
```

If the hashes differ and no authorised upgrade was performed, treat the contract as fully compromised. Do not use it until re-deployed with a new contract ID (see issue #32 for the forensic WASM-comparison process).

---

## 6. Recovery (first 24 hours)

### 6.1 Rotate the admin key

1. Generate a new admin keypair on an air-gapped machine or hardware wallet.
2. Once the break-glass account holds admin rights, call `transfer_admin` from the break-glass account to the new admin address.
3. Revoke the compromised key from all systems immediately.

### 6.2 Re-audit admin key custody

Before unpausing the factory, conduct an emergency review of how the admin key was compromised:
- Was it stored insecurely (clipboard, environment variable, unencrypted file)?
- Was the hardware wallet device physically accessed?
- Was phishing involved?

Document findings and apply remediation before resuming operations.

### 6.3 If WASM was replaced by attacker code

A `upgrade` to attacker-controlled WASM is the most severe scenario. The existing contract at the original address is now malicious and **must not be used**.

Recovery steps:
1. Deploy a **new** factory contract at a fresh contract address.
2. Re-initialize with the new admin address.
3. Notify all integrators and the frontend config must be updated.
4. Publish a security advisory explaining the impact.

### 6.4 Unpause

Only unpause after:
- [ ] Admin key custody is restored to a known-good state.
- [ ] WASM integrity is confirmed against the known-good hash.
- [ ] Fee configuration is verified to be correct.
- [ ] At least one additional team member has independently verified steps 1–3.

```bash
stellar contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --source "$NEW_ADMIN_SECRET_KEY" \
  --network mainnet \
  -- unpause \
  --admin "$NEW_ADMIN_ADDRESS"
```

---

## 7. Break-glass recovery mechanism

This section documents the pre-agreed backup admin account that allows recovery from a scenario where the primary admin key is lost or the attacker has not yet taken over admin rights.

### 7.1 What the break-glass account is

The break-glass account is a **separate Stellar keypair** held by a designated break-glass custodian. It is never used for routine operations. Its sole purpose is to receive admin rights via `transfer_admin` in an emergency, then:
1. Pause the factory.
2. Transfer admin to a freshly-generated recovery key.
3. Facilitate any necessary fee or WASM restoration.

### 7.2 Custody requirements

| Requirement | Detail |
|---|---|
| Storage | Hardware wallet (Ledger or equivalent) held by the break-glass custodian |
| Location | Physically separate from the primary admin hardware wallet |
| Access | Break-glass custodian only; known to the incident commander |
| Testing | Confirmed usable (non-zero XLM balance, key unlocked) at least once per quarter |

### 7.3 Setting up the break-glass address

> Do this **before** mainnet deployment. Record the result in the deployment log.

```bash
# Generate the break-glass keypair on an air-gapped machine
stellar keys generate break-glass --offline

# Fund the break-glass account with at least 5 XLM for transaction fees
stellar keys address break-glass
# Transfer 5+ XLM to this address from the treasury

# Record the break-glass public address (never commit the private key)
BREAK_GLASS_ADDRESS=$(stellar keys address break-glass)
echo "Break-glass address: $BREAK_GLASS_ADDRESS"
```

Add `BREAK_GLASS_ADDRESS` to the deployment log. The private key stays on the hardware wallet.

### 7.4 Activating the break-glass account

When a compromise is confirmed and the primary admin key is still operable, immediately transfer admin rights to the break-glass address:

```bash
stellar contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --source "$ADMIN_SECRET_KEY" \
  --network mainnet \
  -- transfer_admin \
  --admin "$ADMIN_ADDRESS" \
  --new_admin "$BREAK_GLASS_ADDRESS"
```

### 7.5 Multisig threshold (recommended for mainnet)

For higher assurance, configure the admin address as a multisig account requiring M-of-N signers before executing any administrative transaction. This means a single leaked key cannot take any unilateral action.

Setup outline (Stellar multisig):

```bash
# Set the admin account to require 2-of-3 signers
stellar transaction new \
  --source "$ADMIN_ADDRESS" \
  --network mainnet \
  -- set-options \
  --master-weight 1 \
  --low-threshold 2 \
  --med-threshold 2 \
  --high-threshold 2 \
  --signer "$SIGNER_B_PUBLIC_KEY:1" \
  --signer "$SIGNER_C_PUBLIC_KEY:1"
```

With multisig, `transfer_admin` and `upgrade` calls require assembling a transaction and collecting M signatures before submission. This introduces latency in an emergency but dramatically reduces the blast radius of any single key compromise.

---

## 8. Post-incident steps

Complete all of the following after the immediate threat is neutralised.

### 8.1 Forensic WASM comparison (see issue #32)

```bash
# Decompile and diff the on-chain WASM against the last known-good build
stellar contract fetch \
  --id "$FACTORY_CONTRACT_ID" \
  --network mainnet \
  --out-file recovered.wasm

# Compare
diff <(wasm-dis known-good.wasm) <(wasm-dis recovered.wasm)
```

Document any differences as potential attacker modifications.

### 8.2 Full deployment log audit

Review:
- When did the admin key leave the hardware wallet?
- Which machines accessed it?
- What processes had `ADMIN_SECRET_KEY` in their environment?

### 8.3 Rotate all related secrets

- Treasury account keys (if the attacker potentially had access to the same environment).
- Pinata API keys (IPFS).
- Sentry DSN (if the compromise involved the deployment environment).
- Any CI/CD secrets that co-existed with the admin key.

### 8.4 User impact assessment

- Identify all `create_token` or `mint_tokens` calls that were charged inflated fees.
- Identify any tokens whose metadata was manipulated via `set_metadata` while attacker-controlled fees were in place.
- Determine whether any funds in the treasury account were drained via `set_fee_split`.

### 8.5 Disclosure timeline

| Time | Action |
|---|---|
| T+0 | Incident declared, factory paused |
| T+1 h | Internal post-mortem started |
| T+24 h | Initial public notice posted (see below) |
| T+72 h | Full incident report published |
| T+30 d | Follow-up confirming remediation complete |

> Note: StellarForge operates in the "emerging markets fintech-adjacent" space. Depending on the jurisdiction of affected users and the scale of financial impact, applicable data-breach or financial-services notification laws may set shorter or stricter timelines than those above. Consult Legal before publishing the T+24 h notice.

---

## 9. Communication plan

### 9.1 Initial public notice template (publish at T+24 h or sooner if significant user impact)

```
Subject: Security Incident Notice — StellarForge Token Factory

We are writing to inform you of a security incident affecting the StellarForge
token factory contract on Stellar mainnet.

What happened: [brief description — e.g. admin key was compromised; attacker
  temporarily set an inflated creation fee]

When: [UTC time range]

Impact: [number of affected transactions / users; estimated fee overcharge;
  any data that was exposed]

What we've done: The factory was paused at [time]. The admin key has been
  rotated. [Other remediation steps.]

What you should do: [any user action required, e.g. contact support for fee
  refund, do not use the old contract address]

More information: [link to full incident report]

We sincerely apologise for this incident and will publish a full post-mortem
within 72 hours.
```

### 9.2 Channels

- GitHub Security Advisory (private → public after 30 days or sooner)
- Project Discord / Telegram announcement channel
- Direct email to known token creators (if email addresses are available)
- Update the frontend banner to display a maintenance / incident notice

---

## 10. Tabletop exercise checklist

Run this exercise with the actual team at least once before mainnet launch and once per quarter thereafter. It should take approximately 90 minutes.

- [ ] Each team member has read the full runbook.
- [ ] Break-glass address is confirmed funded and accessible.
- [ ] WASM hash monitoring script is deployed and confirmed alerting.
- [ ] Sentry alert rules for anomalous fee events are active.
- [ ] Incident commander and break-glass custodian can reach each other out of band (phone, not just Slack).
- [ ] Walk through section 4 step-by-step on testnet: pause, transfer_admin to break-glass, verify.
- [ ] Walk through section 5.4 WASM integrity check on testnet.
- [ ] Confirm that the communication templates in section 9 are up to date.
- [ ] Document who participated and the date. File in the deployment log.

---

## See also

- [Mainnet deployment checklist](./mainnet-deployment-checklist.md)
- [SECURITY.md](../SECURITY.md) — responsible disclosure policy
- [docs/contract-abi.md](./contract-abi.md) — contract interface reference
- Issue #9 — upgrade event emission (closes the WASM-change detection gap)
- Issue #32 — forensic WASM comparison tooling
- Issue #36 — Sentry correlation for faster anomaly detection
