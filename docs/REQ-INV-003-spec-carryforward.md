# REQ-INV-003 — obligations carried forward to the SPEC

**Source:** `requirements-gate` round 5 on `docs/REQ-INV-003-v6.md` returned **PASS (first clean round)** with five advisory items. They were deliberately **not** edited into v6 so that the three consecutive clean rounds the process asks for are taken against the exact same file. Each item below is **binding on the SPEC** (the `spec-gate` should check it) and the SPEC must be able to point at where each is satisfied.

| # | Applies to | Obligation |
|---|---|---|
| C1 | §3, REQ-INV-012, REQ-INV-019, REQ-INV-013 | An **absent `lineType` is treated as `'product'`**, exactly as `rILT()` (`index.html:8476`), `vInv()` (`:11049`) and `saveInv()` (`:8626`) already do. The resolver, the RAC applicability test and the cost-basis predicate's RAC clause must apply the same defaulting, so a legacy or imported line without the key cannot get an RAC from the form yet fail the predicate. |
| C2 | REQ-INV-023 (named exceptions) | Scope "no direct reads of stored `calc_*`" to **consumers that report cost or profit**. The exhaustive-search test's whitelist must also include `iCalc()`'s line-less branch (`:5589-5591`, kept by REQ-INV-017). The Cloud Data and Sheets mappers (`:5179`, `:6480`, `:6575`, `:7439`, `:8740`) and the CSV import writers (`:11363`, `:11703`) are persistence, not consumers. |
| C3 | REQ-INV-027, AC22 | Add a case: **an earlier line is removed and a later line's RAC is edited** — the audit entry must land on the correct line. This guards a positional snapshot key against misattribution. |
| C4 | REQ-INV-016, AC10 | Say "**resolving** `lid`" wherever that is meant (not merely "has a `lid`"). The intro sentence must read "catalogue-linked **or RAC-bearing** product line". State `from: none` for a first-time RAC in REQ-INV-016 and AC10, not only in REQ-INV-027. |
| C5 | AC4, REQ-INV-021 | Move AC4's RAC fixture into its own criterion (byte-identity "before and after" cannot apply to a fixture with no "before"). State the refusal outcome for **a line that already has an RAC** (the cell reverts to the prior RAC). State that editing a **dangling-`lid` line with no RAC** writes `unitCost` exactly as today. |

Nothing here changes any operator decision (Q1-Q5) or the scope of the fix.
