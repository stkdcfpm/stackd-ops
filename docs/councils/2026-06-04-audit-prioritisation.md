# Council: Audit Prioritisation & Actions
**Date:** 2026-06-04  
**Question:** Was the v2.9.14 multi-framework audit (OWASP, SDLC/PM, DAMA DMBOK v2, BABOK v3) well-prioritised and well-executed? Are the fix/defer decisions the right calls for a tool heading from single-operator to wider rollout?  
**Advisors:** Contrarian, First Principles Thinker, Expansionist, Outsider, Executor  
**Peer review rounds:** 5 (anonymous)  
**Strongest advisor (unanimous):** The Contrarian

---

## Where the Council Agrees

- **SEC-GAP-001 was mislabelled, not deferred.** All five advisors independently named this as the most egregious prioritisation error. Hardcoded Apps Script credentials in a versioned codebase are a live exposure that git history preserves permanently. The fix is one afternoon. There is no defence of the defer decision.

- **The multi-currency KPI inaccuracy is a business-correctness failure, not a display bug.** A freight operator making margin and sourcing decisions off silently wrong aggregated financials is an operational liability. It needed a severity assessment and an interim warning control, not just a gap entry.

- **The CSP/XSS sequencing inverts the security priority stack.** Seven manual `san()` patches were shipped and the systemic control (CSP) was deferred. CSP makes every future XSS patch defence-in-depth rather than primary defence. Deferring the systemic fix while completing whack-a-mole patching is a methodology failure.

---

## Where the Council Clashes

- **Is the architecture a rollout blocker?** First Principles and Outsider argued localStorage is architecturally terminal — rewrite required. Executor and Contrarian treated it as a constraint to work within. Peer review resolved this: "wider rollout" almost certainly means 2–5 users with sync bolted on, not 300 concurrent writers. At that scale the architecture is survivable. It is not survivable at 20+. **The single most important unasked question is: how many operators, on what timeline?**

- **Were XSS fixes premature for single-operator?** First Principles called them pure hygiene. Contrarian and Executor correctly noted those gaps survive unfixed into multi-operator use — fixing them now costs nothing. The fixes were right; framing them as primary defence rather than a layer under CSP was the error.

- **Is the BABOK/DAMA framing overhead?** Largely yes at 1-operator scale. DATA-GAP-001 (FPM calc hardcoding) becomes a real problem the moment a second client needs different rates — deprioritised but not noise.

---

## Blind Spots the Council Caught

- **The Anthropic API key in localStorage (SEC-GAP-003) is the sharpest live edge.** All five advisors walked past it; peer review flagged it. A plaintext LLM API key in localStorage is exfiltrable by any XSS survivor, browser extension, or shared-device session — and carries **direct billing exposure**. Sharper than the Apps Script token because the blast radius includes external charges, not just data access.

- **The backup/recovery gap is the highest-probability failure mode and it is not on the gap list.** localStorage is wiped by browser clear, private browsing, device failure, and profile corruption. The app holds live invoices, POs, shipments, and quotes with no server and no transaction log. Whether the export path is tested, documented, and enforced as the sole recovery mechanism was never audited. **One corrupted browser profile = total data loss.**

- **localStorage storage quota cliff (~5–10 MB).** At scale, localStorage silently fails with no warning, no quota check, no export-before-full guard.

- **The sync layer under multi-operator use went unexamined.** Concurrent writes, partial sync states, conflict resolution, data integrity between localStorage and Sheets — the sync path is the only external data channel and received zero audit coverage.

---

## The Recommendation

The audit was well-executed within its frame, but the frame had two specific errors: SEC-GAP-001 was mislabelled as deferred when it is a pre-rollout blocker, and the entire gap list was assessed against the current system state rather than the 90-day rollout target.

Most fix/defer decisions are correct with three exceptions:
1. SEC-GAP-001 must move to immediate (credentials in source)
2. SEC-GAP-003 must be escalated — billing exposure, not just data exposure
3. Multi-currency KPI inaccuracy needs an interim display warning before any second operator touches the dashboard

The architectural deferral is correct at 2–5 users. Before adding any operator, get a precise answer to **"how many users, on what timeline?"** That single answer scopes every other decision.

The backup/recovery gap is the most dangerous item not on the list — higher probability than any security gap — and must be added and prioritised immediately.

---

## The One Thing to Do First

**Fix SEC-GAP-001.** Move the Apps Script credentials to PropertiesService, rotate the TOKEN, redeploy. One afternoon. The credential is in git history permanently and every day it stays open is a day where anyone who reads the source walks away with working credentials.

---

## Action Status

| Finding | Action taken | Status |
|---|---|---|
| SEC-GAP-001 mislabelled | Code fix shipped (v2.9.14+): `Code.gs` reads from PropertiesService; hardcoded values and `STACKD_CONTEXT.md` references redacted | Code done ✓ — **manual step pending** (set Script Properties, rotate token, redeploy) |
| SEC-GAP-003 billing exposure | Noted in gaps register; no architectural fix possible without server layer | Accepted risk — monitor XSS hygiene |
| Multi-currency KPI inaccuracy | `toGBP()` helper added; all dashboard KPI aggregations convert to GBP equiv. via QR FX rates (v2.9.15) | Done ✓ |
| testConn CORS regression | Fixed (removed Content-Type header causing OPTIONS preflight) | Done ✓ |
| CSP deferral inverts stack | CSP meta tag added to `index.html` `<head>` (v2.9.16): restricts `connect-src https:`, `object-src 'none'`, `base-uri 'self'` | Done ✓ |
| Backup/recovery gap | BACKUP-GAP-001 added to known-gaps.md; `checkStorageQuota()` warns at 75%/90% usage (v2.9.16); DR procedure still undocumented | Partially done — DR procedure pending |
| localStorage quota cliff | BACKUP-GAP-002 added to known-gaps.md; quota warning shipped (v2.9.16); write-side guard pending | Partially done |
| Sync layer under multi-operator | Architectural risk noted; no immediate fix without backend | Deferred — document before adding second operator |
| "How many operators, what timeline?" | **Answered 2026-06-05: 3 operators.** Architecture survivable at this scale per council verdict. Sync layer and localStorage limits must be reviewed before operator 2 is onboarded. | Done ✓ |
