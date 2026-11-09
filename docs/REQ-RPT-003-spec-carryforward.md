# REQ-RPT-003 — SPEC carry-forward obligations (from requirements-gate round 8 on v8)

Round 8 on `REQ-RPT-003-v8.md` was a clean PASS (0 blocking). v8 is NOT edited while the three-consecutive-clean-rounds count runs; these advisories are binding SPEC inputs.

- **A1** ACCT-GAP-004 state: pick ONE state for `docs/known-gaps.md` at merge. Decision: **Open-undetermined** (REQ-8), not "opens only if drift is found". The SPEC and the known-gaps entry say so.
- **A2** The follow-up message (recipe) has no trigger and the later recording of the relayed result has no vehicle. SPEC: the merge-time delivery report explicitly tells the operator to ask for the recipe after deploying; the relayed aggregate result is recorded by a docs-only follow-up commit/PR to `docs/known-gaps.md` (no version bump).
- **A3** REQ-7.5 wording: the no-line count is always NOT VERIFIED at merge (it needs real data); drop the "if that count needs real data" qualifier.
- **A4** Drift test uses `typeof === 'number'` and finite (not `+` coercion); state it. `Unit Cost (catalogue now)` when `lid` resolves but catalogue `cost` is absent/non-numeric: export empty cell; `cInv()` treats it as 0, so COGS uses 0.
- **A5** AC13 owner: the OPERATOR runs the browser check; the session supplies test-data rows only from tests, not from the browser.
- **A6** The relayed recipe output is pasted into an AI session (a transmission to a processor). SPEC: the recipe prints ordinal indexes, class, and numbers only (no invoice numbers, buyers, or descriptions) so the pasted output carries no identifying data.
