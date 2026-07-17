# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in StellarForge, please **do not** open a public GitHub issue.

Instead, report it privately using one of the following channels:

1. **GitHub private security advisory** — open a [private advisory](https://github.com/Favourorg/Stellar-forge/security/advisories/new) in this repository.
2. **Email** — send details to `security@stellarforge.app` with the subject line `[SECURITY] <brief description>`.

Please include:
- A clear description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept code or exploit path).
- Affected contract addresses or frontend versions.
- Your suggested severity (Critical / High / Medium / Low).

We will acknowledge your report within **72 hours** and provide an estimated fix timeline within **7 days**. Please allow us a reasonable time to patch and deploy a fix before public disclosure.

## Scope

| Component | In scope |
|---|---|
| Token factory Soroban contract (mainnet + testnet) | ✅ |
| React frontend (wallet integration, transaction flow) | ✅ |
| IPFS / Pinata integration | ✅ |
| Admin key custody and access controls | ✅ |
| Dependency vulnerabilities with active exploit paths | ✅ |
| Third-party services (Stellar network itself, Pinata, Freighter) | ❌ — report to the respective vendor |
| Theoretical issues with no practical exploit path | ❌ |

## Severity definitions

| Severity | Description |
|---|---|
| **Critical** | Remote code execution, admin key theft, total loss of funds, contract upgrade to attacker WASM |
| **High** | Partial fund loss, admin privilege escalation, persistent denial of service |
| **Medium** | Temporary DoS, fee manipulation without fund loss, user-data leakage |
| **Low** | Minor information disclosure, UX security issues |

## Incident response

For details on how the team responds to a confirmed security incident — including the procedure for a compromised admin key, the break-glass recovery mechanism, and user communication templates — see the [Incident Response Runbook](./docs/incident-response.md).

## Disclosure policy

- We follow a **90-day coordinated disclosure** timeline.
- If a fix cannot be delivered within 90 days, we will publish a mitigation advisory and negotiate an extension with the reporter.
- We will credit reporters in the security advisory unless they request anonymity.
- We do not offer a bug-bounty programme at this time, but we genuinely appreciate responsible disclosures and will acknowledge all valid reports publicly.

## Known security considerations

### Admin key is a single point of trust

The factory contract's `admin` address can upgrade the contract, change fees, redirect treasury funds, and transfer admin rights. Key custody is documented in the [Mainnet Deployment Checklist](./docs/mainnet-deployment-checklist.md). A compromised admin key is a **Critical** severity event; see the [Incident Response Runbook](./docs/incident-response.md) for the response procedure.

### Upgrade lacks an on-chain event (issue #9)

The `upgrade` function currently emits no Soroban event. Detection of a malicious WASM replacement currently requires active polling of the on-chain WASM hash. The monitoring script is documented in the [Incident Response Runbook](./docs/incident-response.md#22-wasm-hash-polling-required-until-issue-9-is-resolved).

### Content Security Policy

A strict CSP is enforced both as a `<meta>` tag and via HTTP response headers on the hosted deployment. See the [README](./README.md#content-security-policy-csp) for configuration details.
