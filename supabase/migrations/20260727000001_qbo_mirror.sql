-- QuickBooks read mirror.
--
-- Why this exists: a live QBO round trip is 1-3 seconds. That is fine in a
-- Telegram card and fatal mid-sentence on a phone call, where dead air is what
-- makes a voice agent feel broken. The agent reads these tables in milliseconds.
--
-- STRICTLY READ-ONLY AND DERIVED. QuickBooks stays the book of record for
-- anything involving money. Nothing here is ever the source of truth, and no
-- code writes back to QBO from these rows. Writes go through Akme's ops tools,
-- behind the existing human-commits gate.

create table qbo_items (
  qbo_id           text primary key,
  name             text not null,
  sku              text,
  description      text,
  unit_price_cents integer,
  qty_on_hand      numeric,
  reorder_point    numeric,
  active           boolean not null default true,
  synced_at        timestamptz not null default now()
);

create index qbo_items_name_idx on qbo_items using gin (to_tsvector('english', name));
create index qbo_items_sku_idx  on qbo_items (sku) where sku is not null;

create table qbo_invoices (
  qbo_id        text primary key,
  customer_id   uuid references customers(id) on delete set null,
  qbo_custid    text,
  doc_number    text,
  total_cents   integer,
  balance_cents integer,
  due_date      date,
  txn_date      date,
  status        text,                              -- paid / open / overdue, derived on sync
  synced_at     timestamptz not null default now()
);

create index qbo_invoices_customer_idx on qbo_invoices (customer_id) where customer_id is not null;
create index qbo_invoices_open_idx     on qbo_invoices (due_date) where balance_cents > 0;

-- Watermark per entity so each sync pulls only what changed. Same shape as the
-- gmail_sync_state watermark the Akme inbound leg already uses.
create table qbo_sync_state (
  entity       text primary key,                   -- 'items' | 'invoices' | 'customers'
  last_synced_at timestamptz,
  last_error   text,
  attempts     integer not null default 0,
  updated_at   timestamptz not null default now()
);

alter table qbo_items      enable row level security;
alter table qbo_invoices   enable row level security;
alter table qbo_sync_state enable row level security;
