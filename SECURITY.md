# Security Policy

## Integrity Verification

OCX uses SHA-256 cryptographic hashes to ensure installed components haven't been tampered with. This protection happens automatically at install-time.

### How it works

1. **Locking**: When a component is first installed, its content is hashed and stored in `ocx.lock`.
2. **Verification**: On subsequent installs or updates, OCX re-hashes the incoming content.
3. **Protection**: If the new hash doesn't match the one in `ocx.lock`, the installation is aborted with an `INTEGRITY_ERROR`.

This ensures that once a version is approved and locked by your team, it cannot be silently swapped for different content, even if the registry itself is compromised.

## Vulnerability Disclosure

We take the security of OCX seriously. If you believe you have found a security vulnerability, please report it to us responsibly.

**Contact**: [ocx-security@alias.kdco.llc](mailto:ocx-security@alias.kdco.llc)

### Disclosure Policy

- **Response Time**: We will acknowledge your report within 48 hours.
- **Resolution**: We aim to provide a resolution or public disclosure within 90 days of the initial report.
- **Coordinated Disclosure**: We ask that you do not disclose the vulnerability publicly until we have had a chance to address it.

## Security Scope

### In Scope
- Vulnerabilities in the OCX CLI tool.
- Issues with the integrity verification mechanism.
- Flaws in the registry resolution logic.

### Out of Scope
- Vulnerabilities in third-party extensions/agents themselves (these should be reported to their respective maintainers).
- Compromise of the local machine where OCX is running.
- Social engineering attacks.
