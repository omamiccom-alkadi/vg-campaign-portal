-- campaigns.source_batch_id — audit parity with contacts
--
-- contacts has carried source_batch_id since the initial schema, so any
-- imported contact can be traced back to the file that loaded it. campaigns had
-- no equivalent: after an import, import_batches recorded how many rows were
-- read and import_errors recorded which were refused, but nothing connected a
-- stored campaign to the batch that produced it. Answering "which import wrote
-- this campaign?" meant comparing timestamps by eye.
--
-- Nullable on purpose, and left NULL for campaigns imported before this
-- migration. A campaign created in the UI has no source file at all, so NULL
-- has to remain a legitimate value; backfilling the existing rows by guessing
-- from created_at would invent provenance we cannot actually prove.

alter table public.campaigns
  add column source_batch_id uuid;

-- DELIBERATELY COMPOSITE, matching contacts_source_batch_fkey. A single-column
-- reference to import_batches (id) would let a brand A campaign cite a brand B
-- import batch — a readable cross-brand edge through any join that follows the
-- link, and the same shape already rejected for campaigns.parent_campaign_id.
-- The composite form accepts exactly the same rows for well-formed data and
-- refuses the cross-brand case at write time.
alter table public.campaigns
  add constraint campaigns_source_batch_fkey
  foreign key (source_batch_id, brand_id)
  references public.import_batches (id, brand_id);

comment on column public.campaigns.source_batch_id is
  'The import batch that last wrote this row, or NULL for a campaign that no import produced (created in the UI, or imported before this column existed). Composite FK on (id, brand_id), so a campaign can only ever cite its own brand''s batch.';

-- Answers "what did this import actually store?" without scanning the table.
-- Partial because campaigns created in the UI never match, and because the rows
-- imported before this migration are permanently NULL.
create index campaigns_source_batch_idx
  on public.campaigns (source_batch_id)
  where source_batch_id is not null;
