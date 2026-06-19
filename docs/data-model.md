# Stackd Ops — Data Model ERD

## Entity Relationship Diagram

```
Contact (DB.con / K.co = 'st_co')
  id              PK
  name
  email           Soft-unique dedup key (case-insensitive)
  phone, company, status, source, gdprBasis, createdAt, lastContactedAt, notes
  enquiries[]     { id, ts, summary, source }  append-only

Quote (DB.qt / K.qt = 'st_qt')
  id              PK
  sourceContactId FK → Contact.id  (optional, '' if none)
  linkedPOId      FK → PO.id       (optional, '' if none)

Contact ─── (0..n) ──→ Quote   via Quote.sourceContactId
```

## Notes

- `sourceContactId` is set when a Quote is created via the "→ Quote" button on a Contact row.
- Deleting a Quote with a `sourceContactId` reverts the linked Contact from `converted` back to `qualified` (if it was `converted`).
- Deleting a Contact leaves dangling `sourceContactId` on associated Quotes — runtime guards no-op safely (CON-GAP-004).
- Contact `gdprBasis` is derived from `status` on every save, not user-editable.
