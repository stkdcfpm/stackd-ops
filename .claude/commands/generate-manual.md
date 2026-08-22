---
name: generate-manual
description: "Regenerate the Stackd Ops Operator Manual as a polished Word (.docx) document from docs/user-guide.md. MANDATORY TRIGGERS: 'generate the manual', 'regenerate the manual', 'rebuild the operator manual', 'create the manual', 'update the manual doc', 'export the user guide to Word'. Use whenever the user wants a shareable/printable version of the operator-facing documentation rather than the raw Markdown in the repo."
---

# Generate the Stackd Ops Operator Manual (.docx)

This turns `docs/user-guide.md` — the living, plain-Markdown reference for how to use the app — into a polished, standalone Word document suitable for printing, emailing to staff, or sharing outside the repo. It is meant to be run **on demand, whenever the user asks**, not automatically on every doc change — `docs/user-guide.md` in Git remains the source of truth; this command produces a point-in-time export of it.

## Before you start

1. **Load the `docx` skill** (`Skill({skill: "docx"})`) before writing any code — it documents real footholds/gotchas for the `docx` npm package (TOC requires built-in heading styles, table width quirks, etc.) that are easy to get wrong without reading it first.
2. Read the current `docs/user-guide.md` in full — this is the sole content source. Do not invent content not present there; if a section reads as thin or stale, that's a signal to fix `docs/user-guide.md` itself first (as its own commit) and then regenerate the manual from the corrected source, not to pad the Word doc independently.
3. Read `CLAUDE.md`'s "Current version" line for the version number to print on the title page/footer.

## Structure to produce

- **Title page**: "Stackd Ops" (large), "Operator Manual" (subtitle), "FPM International" (company), the current version number, and the generation date. Page break after.
- **Table of contents**: an actual Word TOC field (not a hand-typed list) — requires every section heading to use a built-in `HeadingLevel` (see the docx skill's TOC gotcha) so Word can populate it. Page break after.
- **One section per `##` heading in `docs/user-guide.md`**, in the same order the file has them, using `HeadingLevel.HEADING_1`. Any `###` sub-heading inside a section (e.g. under "Orders (Order Requests)") becomes `HeadingLevel.HEADING_2`.
- Body paragraphs: render as normal paragraphs preserving the source's own emphasis (bold `**text**` → bold runs, inline code `` `code` `` → a monospace-font `TextRun`). Bullet lists (`- item`) become a real bulleted list (`numbering` config with `LevelFormat.BULLET`), never a literal `•` character typed into a paragraph.
- Footer on every page: "Stackd Ops Operator Manual — v<version>" left, page number right.
- Page size: match whatever the org already uses for other exported documents in this repo if that's ever established; default to A4 if unspecified (docx-js's own default — no need to override unless asked).

## Output

- Save to `manual/Stackd-Ops-Operator-Manual.docx` in a scratch/output location (not committed to the repo — this is a generated artifact, not a doc source; `docs/user-guide.md` stays the single tracked source of truth). If a `manual/` or similar output convention doesn't exist yet in the repo, just use a sensibly named path in the working directory or scratchpad and hand the file to the user directly.
- **Verify before delivering**: convert to PDF and render a few pages to images (see the docx skill's "Verify the output" section) and actually look at them — confirm the TOC populated, headings look right, no stray artifacts — before sending the file.
- Deliver the finished `.docx` to the user as a file attachment (not inline text).

## Notes for future runs

- If `docs/user-guide.md`'s section structure has changed significantly since this command was last used successfully, re-derive the section list fresh from the current file rather than assuming the list above is still exhaustive — this command describes a *process*, not a fixed table of contents.
- This command doesn't require any GitHub write access or PR — it's a read-then-export operation. No commit is needed unless the user separately asks for the generated file to be checked into the repo (unusual — generated binary artifacts are normally kept out of a public GitHub Pages repo per this project's own public-repo policy in `CLAUDE.md`).
