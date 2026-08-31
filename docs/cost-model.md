# Cost model inputs

All monetary database fields use integer **microcents** to avoid floating-point accounting. For one request:

`reserved cost = ceil(estimated input tokens × input rate / 1,000,000) + ceil(max output tokens × output rate / 1,000,000)`

The tokenizer-independent input estimate uses serialized UTF-8 bytes as a conservative upper bound. Requests containing images reserve the configured alias input ceiling because remote image contents are not available at admission time.

`actual cost` substitutes normalized actual token counts when the provider supplies them. Ambiguous failures retain the conservative reservation estimate.

Before canary, record privately for every route:

- provider/project and contract rate card date;
- input, cached-input (currently unsupported), output, image, and reasoning rates;
- provider rounding/minimums and currency/tax treatment;
- expected request volume, input/output distributions, image frequency, and context percentiles by product;
- Worker, D1 read/write, Durable Object request/storage, logging, and optional AI Gateway costs;
- budget headroom, alert thresholds, expected usage-report delay, and provider-vs-tkslop reconciliation tolerance.

The v1 formula covers token rates only. Do not enable a route with image/request/time-based pricing until the reservation formula explicitly models that price dimension.
