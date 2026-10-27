# Cost model inputs

All monetary database fields use integer **microcents** to avoid floating-point accounting. For one request:

`reserved cost = ceil(estimated input tokens × input rate / 1,000,000) + ceil(max output tokens × output rate / 1,000,000)`

The tokenizer-independent text input estimate uses serialized UTF-8 bytes, capped at the alias input ceiling. Billable image requests are rejected before admission until the selected adapter/model has a reviewed image-token bound; an alias ceiling is not an upstream input limit. Non-billable fixtures still reserve the alias input ceiling for images. Max output tokens is the client's limit clamped to the alias ceiling, or 4,096 (clamped) when omitted; the same limit is sent to the provider.

Settlement records reported usage even when it exceeds the reservation, including classroom spend. Admission limits future work; it cannot undo a provider overrun. Capping settlement would hide incurred cost and permit additional spending. Overruns require reconciliation with the provider and review of the route's reservation contract.

`actual cost` substitutes normalized actual token counts when the provider supplies them, including protocol errors for input/output-limit violations. Missing usage fields retain their individual estimates. Ambiguous failures without measured usage retain the reservation estimate; definitive provider rejections are not charged. Before settling measured cost above the reservation, the gateway updates the unresolved D1 intent with that evidence. Failed quota completion leaves that intent unresolved for manual reconciliation, not finalized as a successful settlement. Simultaneous storage failures or termination before that write can still lose measured evidence; this is not invoice-grade exactly-once reconciliation.

Migration `0007_measured_usage_bounds.sql` permits normalized measured token counts above the old 10,000,000-input/200,000-output request envelopes and removes the corresponding cost ceiling from attempt evidence. Quota completion still requires safe integer totals; extreme provider reports whose token sum or computed cost cannot be represented safely remain unresolved for manual reconciliation rather than being clamped. The migration must precede deployment; see [ADR 0007](adr/0007-provider-policy.md).

Before canary, record privately for every route:

- provider/project and contract rate card date;
- input, cached-input (currently unsupported), output, image, and reasoning rates;
- provider rounding/minimums and currency/tax treatment;
- expected request volume, input/output distributions, image frequency, and context percentiles by product;
- Worker, D1 read/write, Durable Object request/storage, logging, and optional AI Gateway costs;
- budget headroom, alert thresholds, expected usage-report delay, and provider-vs-tkslopper reconciliation tolerance.

The v1 formula covers token rates only. Do not enable a route with image/request/time-based pricing until the reservation formula explicitly models that price dimension.
