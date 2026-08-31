# Contributing

1. Keep changes inside tkslop's documented ownership boundary.
2. Never commit secrets, production values, user/customer/student data, prompts, responses, images, filenames, raw IPs, or generated local state.
3. Add or update an executable contract for behavior changes.
4. Run `pnpm check` and `pnpm audit --audit-level=high`.
5. Describe security, privacy, accounting, compatibility, and rollout effects in the pull request.

Changes to identity, token signing, quota serialization, provider routing, logging fields, or the public API require adversarial review and an ADR update when the decision changes.
