-- SPEC-CLOUD-006: extends the Cloud Data shared-database layer to Invoice and Credit
-- Note — one shared table, matching how DB.inv already holds both record shapes
-- locally (a Credit Note is a `type` flag on an Invoice-shaped record, not a
-- separate array — REQ-CLOUD-006 §0).
--
-- `buyer_id`/`linked_quote_id`/each element of `pos` are deliberately NOT
-- foreign-key-constrained, matching every prior cross-entity reference in this
-- series (`sup_id`/`inv_id`/`quote_id` on `purchase_orders`, `source_contact_id`
-- on `quotes`) — `text`, not `uuid`, since the referenced entity's local id is
-- not RFC-4122 format before ITS OWN migration completes, and a plain-text
-- column accommodates a record created either before or after that point
-- uniformly, with no schema-level distinction.
--
-- `linked_inv_id` (the CN → Invoice self-reference, REQ-CLOUD-006b) is ALSO
-- deliberately left as plain `text`, not a real `references invoices(id)`
-- foreign key, even though both ends of this reference live in the same table
-- being migrated in one batch (which would make a real FK constraint
-- structurally safe for THIS migration's own two-pass insert). It is kept
-- consistent with every other cross-reference column in this series instead,
-- for two reasons: (1) `INV-GAP-002` (logged, not fixed, by this REQ — §3)
-- already accepts that `delInv()` can leave a dangling `linkedInvId` behind on
-- an ordinary delete, post-migration, with no cleanup — a real FK constraint
-- would make Postgres reject that exact scenario's corresponding CN row update
-- rather than silently tolerating the pre-existing, accepted gap; and (2) it
-- keeps the whole table's cross-reference-column story uniform rather than
-- carving out one field as the sole exception.
--
-- `line_items`/`pos` are `jsonb`, matching every prior entity's embedded-array
-- convention. `pos` holds Purchase Order ids exactly as `DB.inv[].pos[]` does
-- locally — by the time Invoice migrates, REQ-CLOUD-006a's own four-entity
-- precondition guarantees Purchase Order has already fully migrated, so every
-- element already IS a real Supabase Purchase Order id, needing no further
-- transformation on insert.
--
-- `date`/`expiry`/`ship_date` are `text`, not `date` — matches every prior
-- entity's identical <input type="date">.value convention (Quote's `dt`,
-- Purchase Order's `date`), never a JS Date object, never reformatted.
--
-- `tax_rate`/`lf`/`ins`/`leg`/`isp`/`oth`/`dep`/`cn_amount`/the eight `calc_*`
-- fields are `numeric` — Invoice's own JS convention stores the `calc_*`
-- fields as strings (`String(gt)`, etc.) purely for display-formatting
-- convenience, matching how `numeric` already round-trips through this app's
-- other entities (Quote's `calc_total_landed` etc.) as a string via the
-- Supabase client's own JSON serialization of arbitrary-precision numeric
-- types — refreshInvFromSupabase() (§2.3) explicitly re-stringifies them on
-- read back, matching the local convention exactly rather than leaving them
-- as JS numbers.
--
-- `buyer_approved_at` is `timestamptz`, matching `saveInvApprove()`'s own
-- `new Date().toISOString()` assignment and Quote's identical `approved_at`
-- precedent — never a bare date string.
--
-- `edit_history` is `jsonb`, nullable, no default — only present on a record
-- that has actually been through the G-05/G-06 unlock-and-edit workflow at
-- least once; most records never carry this key at all, matching how
-- `refreshInvFromSupabase()` (§2.3) omits it entirely rather than writing an
-- empty array onto a record that never had the key.
--
-- `_demo` is deliberately excluded, matching REQ-CLOUD-003/004/005's identical
-- precedent — it carries forward unchanged in the local record only, never
-- sent to Supabase.

create table invoices (
  id                  uuid primary key default gen_random_uuid(),
  num                 text not null unique,
  type                text not null default 'invoice',
  buyer_id            text,
  buyer               text,
  buyer_addr          text,
  ship_to             text,
  dst                 text,
  cust_id             text,
  date                text,
  expiry              text,
  ship_date           text,
  ft                  text,
  wt                  text,
  cbm                 text,
  pk                  text,
  pol                 text,
  pod                 text,
  coo                 text,
  cur                 text,
  tax_rate            numeric,
  lf                  numeric,
  ins                 numeric,
  leg                 numeric,
  isp                 numeric,
  oth                 numeric,
  dep                 numeric,
  incoterm            text,
  payment_terms       text,
  terms               text,
  charges_included    boolean,
  status              text not null,
  line_items          jsonb not null default '[]'::jsonb,
  pos                 jsonb not null default '[]'::jsonb,
  buyer_approved_at   timestamptz,
  buyer_approved_by   text,
  approval_method     text,
  approval_note       text,
  linked_quote_id     text,
  linked_quote_num    text,
  linked_inv_num      text,
  linked_inv_id       text,
  cn_reason           text,
  cn_amount           numeric,
  notes               text,
  edit_history        jsonb,
  calc_grand_total    numeric,
  calc_cogs           numeric,
  calc_gross_profit   numeric,
  calc_net_profit     numeric,
  calc_margin         numeric,
  calc_balance_due    numeric,
  calc_li_total       numeric,
  calc_tax_amt        numeric,
  upd_at              timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

alter table invoices enable row level security;

create policy "authenticated read" on invoices for select using (auth.role() = 'authenticated');
create policy "authenticated write" on invoices for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on invoices for update using (auth.role() = 'authenticated');
-- deliberately no delete policy — soft-delete only, enforced by omission
