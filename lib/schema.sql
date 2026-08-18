-- Sending numbers. One linked WhatsApp account each.
-- Counters (sent today / this hour) are NOT stored here: they are derived from
-- `messages` so there is a single source of truth and nothing can drift.
create table if not exists senders (
  id                serial primary key,
  phone             text unique not null,
  label             text,
  status            text not null default 'warming',  -- warming|active|paused|banned
  max_per_day       int  not null default 60,         -- ceiling once warmup finishes
  max_per_hour      int  not null default 8,
  warmup_started_at timestamptz not null default now(),
  paused_until      timestamptz,                      -- health / recovery cool-down
  break_until       timestamptz,                      -- micro-break between bursts
  proxy_url         text,                             -- socks5://user:pass@host:port
  created_at        timestamptz default now()
);

-- Health penalties. Score = sum(points) over the last 24h, so it decays on its own.
create table if not exists sender_events (
  id         bigserial primary key,
  sender_id  int not null references senders(id) on delete cascade,
  kind       text not null,   -- disconnect|send_failed|timelock|rate_limited|forbidden|logged_out|warmup|resumed
  points     int  not null default 0,
  detail     text,
  at         timestamptz not null default now()
);
create index if not exists sender_events_recent on sender_events (sender_id, at desc);

create table if not exists leads (
  id         serial primary key,
  list       text not null,
  phone      text not null,                      -- digits only, country code included
  name       text,
  vars       jsonb not null default '{}',
  status     text not null default 'new',        -- new|active|replied|invalid|done|opted_out
  sender_id  int references senders(id) on delete set null,  -- sticky thread owner
  created_at timestamptz default now(),
  unique (list, phone)
);
create index if not exists leads_phone on leads (phone);

-- Global do-not-contact. Spans every list and campaign, forever.
create table if not exists blocklist (
  phone      text primary key,
  reason     text,
  created_at timestamptz default now()
);

create table if not exists campaigns (
  id             serial primary key,
  name           text not null,
  list           text not null,
  status         text not null default 'draft',  -- draft|running|paused|done
  min_delay_sec  int  not null default 90,
  max_delay_sec  int  not null default 300,
  start_hour     int  not null default 9,        -- server local time
  end_hour       int  not null default 19,
  skip_weekends  boolean not null default true,
  cooldown_days  int  not null default 30,       -- don't re-contact a number seen this recently
  created_at     timestamptz default now()
);

-- One step of a sequence. `bodies` holds A/B variants; index 0 is variant A.
create table if not exists steps (
  id           serial primary key,
  campaign_id  int not null references campaigns(id) on delete cascade,
  step_no      int not null,
  bodies       text[] not null,
  delay_hours  numeric not null default 0,       -- wait after the previous step
  unique (campaign_id, step_no)
);

create table if not exists messages (
  id            serial primary key,
  campaign_id   int not null references campaigns(id) on delete cascade,
  lead_id       int not null references leads(id) on delete cascade,
  step_no       int not null,
  variant       int not null default 0,
  sender_id     int references senders(id) on delete set null,
  status        text not null default 'pending', -- pending|sent|failed|canceled|skipped
  body          text,
  body_hash     text,                            -- duplicate-content guard per sender
  wa_id         text,                            -- WhatsApp message id, for ack tracking
  scheduled_at  timestamptz not null default now(),
  sent_at       timestamptz,
  delivered_at  timestamptz,
  read_at       timestamptz,
  error         text,
  unique (campaign_id, lead_id, step_no)
);
create index if not exists messages_due on messages (status, scheduled_at);
create index if not exists messages_sent on messages (sender_id, sent_at desc);
create index if not exists messages_wa_id on messages (wa_id);
-- Makes "sent today / this hour" a small range scan instead of a scan of all
-- history. This is the query the daily and hourly caps are enforced from, so it
-- runs on every send and must stay O(today), not O(everything).
create index if not exists messages_recent on messages (sent_at desc) where status = 'sent';
create index if not exists messages_lead on messages (lead_id);

create table if not exists replies (
  id           serial primary key,
  sender_phone text not null,
  lead_phone   text not null,
  body         text,
  outbound     boolean not null default false,   -- true = you replied from the inbox
  received_at  timestamptz default now()
);
create index if not exists replies_recent on replies (received_at desc);
create index if not exists replies_thread on replies (lead_phone, received_at desc);

-- Additive migrations. Every statement is idempotent, so migrate() can run on boot
-- against a fresh database or one that predates the column.
alter table replies add column if not exists read_at timestamptz;
-- Per-number pacing clock. Each number waits out its own randomised gap, so
-- adding numbers adds throughput instead of queueing behind one global timer.
alter table senders add column if not exists next_ready_at timestamptz;
-- How fast a number's daily cap grows. 1.3 reaches the ceiling in about a week;
-- 1.12 stretches it over three weeks, which is closer to email warmup practice.
alter table senders add column if not exists warmup_growth numeric not null default 1.3;
-- Send windows are evaluated in the campaign's own timezone, not the server's.
alter table campaigns add column if not exists timezone text not null default current_setting('TimeZone');
-- Opt-out from the send window, for the operator who wants a campaign to go the
-- moment they create it. Off by default: the window is the safer behaviour and
-- the one every campaign should normally follow.
alter table campaigns add column if not exists ignore_send_window boolean not null default false;
-- Why the classifier tagged a reply the way it did, so you can sanity-check it.
alter table replies add column if not exists ai_reason text;
-- The public IP this number's traffic actually leaves from. Numbers sharing one IP
-- are correlated to each other, which is the part of IP hygiene that matters here.
alter table senders add column if not exists egress_ip text;

-- Single-row settings for things that belong to the install rather than the code.
create table if not exists app_settings (
  id         int primary key default 1 check (id = 1),
  ai_enabled boolean not null default true,   -- automatic reply tagging
  updated_at timestamptz default now()
);
insert into app_settings (id) values (1) on conflict (id) do nothing;
alter table leads   add column if not exists interest text not null default 'unset';  -- unset|positive|neutral|negative|meeting
alter table leads   add column if not exists note text;

-- Operator overrides for the sending limits. Holds only the keys actually changed
-- away from the POLICY defaults in lib/safety.ts, e.g. {"hardMaxPerDay": 120}, so a
-- default install stores '{}' and follows the code. Values are clamped before they
-- are written and re-checked on read, so a hand-edited row cannot widen a limit.
alter table app_settings add column if not exists limits jsonb not null default '{}';
-- Reply tagging: one key per provider, set from the dashboard and preferred over the
-- matching environment variable, so a key can be added without a restart. None of
-- these is ever returned by the API, only a masked hint.
alter table app_settings add column if not exists anthropic_api_key text;
alter table app_settings add column if not exists google_api_key text;
alter table app_settings add column if not exists openai_api_key text;
-- Which provider tags replies, the model id to ask for, and the instructions to send
-- with each one. Null model or prompt means the default for the chosen provider.
alter table app_settings add column if not exists ai_provider text not null default 'anthropic';
alter table app_settings add column if not exists ai_model text;
alter table app_settings add column if not exists ai_prompt text;
-- Dashboard password as 'salt:hash', both hex, from node:crypto scrypt with a
-- random salt. The plaintext is never stored, logged or returned.
alter table app_settings add column if not exists password_hash text;

-- The WhatsApp message id of an inbound reply. Unique per contact, so the same
-- message arriving twice — WhatsApp re-delivers what it queued while a socket was
-- down, and one message can come through as both 'notify' and 'append' — cannot
-- double-count in the inbox or in the reply-rate gate that decides whether a number
-- is burnt. Null for rows you sent from the inbox and for rows written before this
-- column existed; Postgres allows duplicate nulls in a unique index.
alter table replies add column if not exists wa_id text;
create unique index if not exists replies_wa_id on replies (lead_phone, wa_id);

-- WhatsApp login material: the credentials and signal keys Baileys would otherwise
-- keep in SESSION_DIR as loose JSON files. In here they get one writer per number and
-- atomic writes, which the file store cannot promise — two sockets sharing a
-- directory each keep their own copy of creds.json and the loser is rejected with 440
-- (conflict) forever. Treat these rows as the passwords they are: they are enough to
-- act as the number, no API is allowed to return them, and a database backup of this
-- table is a backup of the WhatsApp logins.
create table if not exists wa_auth (
  phone      text not null,
  id         text not null,          -- 'creds', or Baileys' '<key type>-<key id>'
  data       text not null,          -- JSON, Buffers encoded by Baileys' BufferJSON
  updated_at timestamptz default now(),
  primary key (phone, id)
);

-- "Has this contact been messaged?" and "which of a campaign's contacts replied?"
-- are both derived rather than stored, so both have to find a lead's sent messages
-- cheaply. Partial and single-column on purpose: only 'sent' rows can answer either
-- question, which keeps this at 17MB against a 352MB table. Measured on 2.3M
-- messages / 100k leads / 14k replies: the per-campaign "Answered" count goes from
-- 117ms to 39ms and the per-list "Messaged" count from 229ms to 42ms.
create index if not exists messages_sent_lead on messages (lead_id) where status = 'sent';
