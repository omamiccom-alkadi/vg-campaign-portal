-- Campaigns, events and historical sends need the same import audit trail that
-- contacts already has, and import_batches / import_errors already generalise:
-- neither carries a contacts-specific column, and the only link between them
-- and contacts is contacts.source_batch_id pointing inward.
--
-- What is missing is a way to tell the kinds apart. Without it the Contacts
-- page's history would offer 'karoo-campaigns.csv' as a contacts import and
-- render its rejected rows as though they were contacts, which is a quietly
-- wrong screen rather than a broken one.
--
-- Additive and defaulted, so every batch written before this migration keeps
-- exactly the meaning it had.

alter table public.import_batches
  add column entity text not null default 'contacts'
    check (entity in ('contacts', 'campaigns', 'events', 'sends'));

comment on column public.import_batches.entity is
  'Which table this batch loaded. Defaults to contacts so rows predating this column keep their meaning. Readers MUST filter on it: an import_errors row is only interpretable alongside its batch entity, since row_number and raw_row mean different things per source file.';

-- import_batches_brand_created_idx still covers the unfiltered history. This
-- one keeps the per-entity list cheap once several kinds of import coexist.
create index import_batches_brand_entity_created_idx
  on public.import_batches (brand_id, entity, created_at desc);

-- Deliberately NOT touching import_batches_brand_checksum_idx. It is unique on
-- (brand_id, file_checksum) for completed batches, and two different entities
-- cannot collide there: distinct files produce distinct checksums. Adding
-- entity to that index would weaken a duplicate-upload guard, not strengthen
-- it, by allowing the same file to be re-imported once per entity.
