# ADR 0009: Public repository security

**Status:** Accepted

## Decision

Treat every tracked byte and Git commit as public. Commit only placeholders, synthetic fixtures, and fake hostnames. Ignore local secrets/state, document Wrangler secret workflows, audit dependencies, scan full history with Gitleaks, and fail CI on suspicious tracked files or high-risk credential patterns.

Do not publish real domains, account IDs, D1 IDs, provider projects, keys, customer/student data, incident details, or private retention/DPA terms.

## Consequences

Environment examples are deliberately nonfunctional until an operator supplies private values. Secret removal from the tip is insufficient; exposure requires rotation and history incident handling.
