# Security policy

## Supported versions

Until the first stable release, only the current default branch is supported.

## Reporting

GitHub private vulnerability reporting is the required private channel for this repository. A repository administrator must enable **Settings → Code security and analysis → Private vulnerability reporting**. Once enabled, use **Security → Report a vulnerability**. Do not include secrets, live access codes, prompts/responses, student/customer records, raw IP addresses, or private deployment values in public issues.

No security-specific fallback with a published owner and response expectation is currently available. Until GitHub private reporting is enabled, do not disclose vulnerability details publicly; a detail-free public issue may ask the maintainers to enable private reporting.

## Repository posture

- No production deployment values or provider credentials belong in Git.
- `.dev.vars`, `.env*` (except examples), Wrangler local state, logs, and generated artifacts are ignored.
- Fixture identities and payloads are synthetic and public-safe.
- CI uses read-only repository permissions, pins third-party Actions and the Gitleaks image to immutable reviewed references, and runs dependency auditing, full-history secret scanning, and an explicit tracked-file hygiene check.
- Dependabot checks npm and GitHub Actions dependencies weekly.
- A leaked service credential, access code, signing secret, pepper, admin token, or provider key must be revoked/rotated; deleting a Git line is not remediation.

See [the incident and key-rotation runbook](docs/runbooks/operations.md).
