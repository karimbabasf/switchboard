/**
 * Row types for every table switchboard owns, plus the read-only shapes it
 * borrows from Akme. This file is the contract between modules: if a module
 * needs a field that is not here, the schema changes first, not the type.
 */

export type Direction = 'inbound' | 'outbound';

export interface Contact {
  phone: string; // E.164, primary key
  display_name: string | null;
  customer_id: string | null; // -> customers.id, null for strangers
  telegram_topic_id: number | null; // nullable AND replaceable, topics can be deleted
  topic_created_at: string | null;
  // Non-null means no outbound message may reach them by ANY path, machine or
  // human. Enforced at the door in lib/telnyx/sms.ts sendSms, not at the point
  // a reply is decided, because a human tapping Send has to be covered too.
  opted_out_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  contact_phone: string;
  direction: Direction;
  body: string | null;
  media: MediaItem[];
  provider_id: string | null;
  provider_status: string | null;
  telegram_message_id: number | null;
  created_at: string;
}

export interface MediaItem {
  url: string;
  content_type: string;
}

export type CallStatus = 'new' | 'fetching' | 'transcribing' | 'summarizing' | 'posted' | 'failed';

export interface Call {
  id: string;
  contact_phone: string;
  direction: Direction;
  provider_call_id: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  was_answered: boolean;
  recording_url: string | null;
  storage_path: string | null;
  transcript: string | null;
  summary: CallSummary | null;
  status: CallStatus;
  attempts: number;
  last_error: string | null;
  telegram_message_id: number | null;
  created_at: string;
  updated_at: string;
}

/** What the summarizer must return. Kept small on purpose: a card nobody reads is waste. */
export interface CallSummary {
  headline: string; // one line, what the call was about
  caller_wanted: string;
  commitments: string[]; // anything we said we would do
  action_items: string[];
  needs_followup: boolean;
  sentiment: 'positive' | 'neutral' | 'negative';
}

export type OutboxKind = 'text' | 'audio' | 'document' | 'edit';

export interface OutboxRow {
  id: string;
  thread_id: number | null; // null targets the General topic (omit the param, never send 1)
  kind: OutboxKind;
  payload: Record<string, unknown>;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  sent_message_id: number | null;
  created_at: string;
}

export interface Responder {
  id: string;
  name: string;
  phone: string;
  ring_order: number; // same value rings simultaneously, higher is a later wave
  active: boolean;
  telegram_user_id: number | null;
  created_at: string;
}

export interface CallbackAction {
  id: string;
  action: string;
  params: Record<string, unknown>;
  expires_at: string;
  created_at: string;
}

// --- QuickBooks mirror. Read-only and derived, never the book of record. -----

export interface QboItem {
  qbo_id: string;
  name: string;
  sku: string | null;
  description: string | null;
  unit_price_cents: number | null;
  qty_on_hand: number | null;
  reorder_point: number | null;
  active: boolean;
  synced_at: string;
}

export interface QboInvoice {
  qbo_id: string;
  customer_id: string | null;
  qbo_custid: string | null;
  doc_number: string | null;
  total_cents: number | null;
  balance_cents: number | null;
  due_date: string | null;
  txn_date: string | null;
  status: string | null;
  synced_at: string;
}

// --- Akme-owned, READ ONLY. switchboard never writes these. ----------------

export interface AkmeCustomer {
  id: string;
  business_id: string;
  email: string | null;
  name: string | null;
  company: string | null;
  phone: string | null;
  zip: string | null;
  external_ids: Record<string, unknown>;
}

export interface AkmeOrder {
  id: string;
  customer_id: string | null;
  seq: number;
  reference: string | null;
  status: string;
  need_by: string | null;
  total_cents: number | null;
  created_at: string;
}
