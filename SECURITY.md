# Security policy

## Supported versions

Until the first stable release, only the current default branch is supported.

## Reporting

Report vulnerabilities privately through GitHub's **Security → Report a vulnerability** flow. Do not include secrets, live access codes, prompts/responses, student/customer records, raw IP addresses, or private deployment values in public issues.

If private reporting is unavailable, contact Tinkertanker through its established security contact channel and reference this repository without sending exploit data in the first message.

## Repository posture

- No production deployment values or provider credentials belong in Git.
- `.dev.vars`, `.env*` (except examples), Wrangler local state, logs, and generated artifacts are ignored.
- Fixture identities and payloads are synthetic and public-safe.
- CI runs dependency auditing, Gitleaks history scanning, and an explicit tracked-file hygiene check.
- A leaked service credential, access code, signing secret, pepper, admin token, or provider key must be revoked/rotated; deleting a Git line is not remediation.

See [the incident and key-rotation runbook](docs/runbooks/operations.md).
