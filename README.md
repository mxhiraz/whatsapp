# WA Outreach

The cold-email stack (lists, sequences, sender rotation, warmup, deliverability, a
unified inbox), rebuilt for WhatsApp.

Upload numbers, write a sequence, link a few WhatsApp numbers by QR, hit start. The
engine paces each number independently, warms new ones up, stops a sequence the
moment someone replies, and pauses any number that starts looking burnt.

```
┌── numbers ───────────┐      ┌── engine ────────────────┐      ┌── leads ─────┐
│ +9198…  active  47/60│      │ pick due message         │      │ CSV import   │
│ +9197…  warming 12/17│ ──▶  │ pick a free number       │ ──▶  │ {{vars}}     │
│ +9196…  paused (403) │      │ render unique copy, send │      │ sequences    │
└──────────────────────┘      │ ack, pace, break, judge  │      └──────────────┘
                              └──────────────────────────┘
```

## Read this first

**No tool can guarantee your numbers won't get banned, and this one doesn't claim
to.** Automating the consumer WhatsApp app violates WhatsApp's Terms of Service,
Meta's ban classifier is closed and non-deterministic, and cold messaging strangers
is precisely what it is built to catch. Anything advertised as "100% ban-proof" is
lying to you.

What this project actually offers is different and checkable: every known
ban-avoidance technique is implemented, enforced by the engine rather than left to
your discipline, and **proven by a test suite that runs the real engine and asserts
each rule fires** (`npm run test:flow`, 16 rules; see [Proof](#proof)). Numbers
still burn eventually. The goal is that it takes months instead of days, that one
burnt number never takes the others with it, and that the system notices and pauses
before Meta does.

Use numbers you can afford to lose, honour opt-outs, and check your local marketing
law (GDPR, TCPA, India's TRAI rules). If you need a genuinely ban-safe path, use
Meta's official WhatsApp Business Cloud API, which does not permit cold first
contact at all. That trade-off is the whole reason this project exists.

## Quickstart

One command brings up Postgres, the dashboard and the send loop:

```bash
docker compose up -d          # → http://localhost:7070
```

The schema is applied on boot and each number's WhatsApp session is stored in
Postgres, so rebuilds and restarts don't cost you a QR re-scan. Sessions created by
an older version are imported from `SESSION_DIR` the first time that number
connects. For development instead:

```bash
docker compose up -d db       # just Postgres, on :5439
npm install && npm run dev    # → http://localhost:7070
```

Then, in the dashboard:

1. **Numbers** → add a phone, scan the QR (WhatsApp → Settings → Linked devices).
2. **Contacts** → paste or upload a CSV. A `phone` column is required; every other
   column becomes a `{{variable}}`.
3. **Campaigns** → write step 1, add follow-ups, Create, Start.

## Features

| | |
|---|---|
| **Bulk import** | Any CSV/TSV export, column mapping, per-row selection, per-list dedupe, row-level error report. See [Importing contacts](#importing-contacts) |
| **Sequences** | Unlimited steps, per-step delay in hours, auto-cancel on reply |
| **A/B variants** | Multiple bodies per step, split by lead, delivery/read/reply rate reported per variant |
| **Personalisation** | `{{first_name}}`, `{{company}}`, any CSV column, plus `{spin|tax}` so no two messages match |
| **Number rotation** | Every number sends on its own clock, weighted to the least-used and healthiest |
| **Sticky threads** | Follow-ups always come from the number that opened the conversation |
| **Warmup** | New numbers ramp from 10 strangers/day to their ceiling, over about a week or about three weeks (your choice per number) |
| **Deliverability** | Delivery and read receipts per message, aggregated per number and per variant. See [What the numbers mean](#what-the-numbers-mean) |
| **Inbox** | Unread counts, filters (unread / interested / opted out), search, reply from the owning number, interest tagging, private notes |
| **Contacts** | Open a list to search it, edit a contact, or delete one; CSV export per list and per campaign |
| **Opt-out** | "stop"/"unsubscribe"/"not interested" (and Hinglish) → global blocklist, whole queue cancelled |
| **Global cooldown** | A number contacted by one campaign is off-limits to the others for N days |
| **Proxy per number** | Optional SOCKS5 per sender, sticky and never rotated, so numbers aren't correlated by a shared IP. The dashboard warns when two share one |
| **Health engine** | Risk scoring, slow-down, auto-pause and staged recovery |
| **Catch-up** | "Send queued messages now" drops the waiting when a campaign started late, behind a confirm that says what it costs |
| **Test send** | One real message to any number you choose, so you can watch it arrive without spending a cold send |
| **Dry run** | `WA_DRY_RUN=1` stubs WhatsApp entirely, so you can develop and test without touching a real number |
| **Interface** | shadcn/ui, light/dark/system theme, a real URL per section, every metric explained in a tooltip |
| **Integrations** | CSV import and export, optional password login, optional AI reply tagging with your own Claude, Gemini or ChatGPT key |

## Importing contacts

Import is two passes, the way cold-email tools do it: read the file, show you what
was found, then write.

**Any export works.** The phone column is found by **content, not by header name**:
whichever column has the most values that parse as a phone number wins. So a file
with `Ph No`, `Mobile #`, or no header row at all still imports. Handled without
configuration:

- `,` `;` tab and `|` delimiters, detected per file
- quoted fields containing the delimiter or newlines, doubled `""` escapes
- CRLF line endings and the UTF-8 BOM Excel writes
- Excel's text-guard apostrophe (`'919876543210`)
- header row present or absent
- `+91 98765 43210`, `98765 43210`, `0098…`, `09876…` → all normalised to digits-only
  E.164, with your chosen country code filled in for bare 10-digit numbers

Then you check the mapping. Every column is listed with example values and a
dropdown: phone number, name, use as `{{tag}}`, or don't import. Sniffing sets the
defaults, but content can't tell a person's name from a company name, so that one is
worth a look. Any column you keep as a tag becomes a template variable.

**And you pick who to import.** Every parsed row is listed with a checkbox, all
ticked by default, so a file can be imported in part rather than whole. Past 5,000
rows the picker steps aside and the file imports wholesale. Sending that many rows
to the browser to tick individually isn't sensible.

Before writing, it tells you what will happen: how many rows are ready, how many
repeat inside your own file, how many are already in this list, how many are in a
different list, how many are opted out, and which rows are unusable *with their line
numbers and the reason*. Opted-out numbers are never imported in the first place:
not imported and then skipped at send time.

## How the ban-avoidance works

WhatsApp publishes no message limit; bans come from ML heuristics. Ranked by how
much they matter for cold outreach:

1. **Who you message.** Every cold lead is a stranger with no contact-graph link to
   you. Stranger volume is the binding constraint, not total volume.
2. **Reply ratio.** A number that talks and never gets answered looks like spam.
3. **Block/report rate.** Invisible to us, so it is proxied by send failures, 403s
   and delivery collapse.
4. **Robotic timing.** Fixed intervals, round-the-clock activity, identical copy.

The whole policy lives in one file, [`lib/safety.ts`](./lib/safety.ts), as pure
functions with their own asserts. The numbers below are its defaults. Six of them
are editable from the dashboard's Settings tab: the day-one allowance, how fast it
ramps, the hard ceiling, how often a number rests, and the reply and delivery floors
that pause a number. Everything else is code, not configuration. Each editable
value has a range in the same file, and both directions are guarded. A value you
type is pulled to the nearest bound before it is stored, and a stored value that
sits outside its range is ignored on the way out in favour of the default, so
editing the row by hand in psql cannot widen a limit.

- **Warmup ramp.** Day 1 is 10 strangers, then ×1.3/day (about a week to the
  ceiling) or ×1.12/day (about three weeks), chosen per number. A hard cap of
  200/day sits above whatever the UI says.
- **Daily target jitter.** Each number aims for 70–100% of its cap, re-rolled daily
  and seeded per number, so no two days and no two numbers look alike.
- Gaps between sends are a bell curve inside your min/max rather than a flat random
  pick, multiplied by a time-of-day curve (fastest 10:00–14:00, 2.5× slower at the
  fringes). Each number waits out its own gap.
- **Send window.** Configurable hours, weekdays-only by default, evaluated in the
  campaign's own timezone (it defaults to your browser's, not the server's). A running
  campaign that is outside its window says so on the campaign row rather than sitting
  silently at zero. A campaign can opt out of the window entirely with "Ignore send
  hours", which is off by default: messages arriving at 3am are one of the clearest
  bot signals there is, so the override exists for the campaign you need out now, not
  as a way to run around the clock.
- Every number takes a 20–55 min rest after each run of 8–14 sends, the way a
  person working a list would.
- **Typing simulation.** Presence goes `available` → `composing` for a length-scaled
  duration → `paused` → `unavailable`. Inbound messages are marked read after
  20–120s instead of instantly.
- **Duplicate-copy guard.** At most 2 identical messages per number per hour.
  Spintax (the `{a|b}` syntax that varies a message) is re-rolled up to 6 times; if
  every attempt still collides, the send is deferred 45 min.
- **Reply-rate gate.** Under 10% warns, under 4% auto-pauses the number for 48h,
  once it has 30 sends to judge on. This usually means the copy or the list is
  broken, not the sending setup.
- **Delivery-rate gate.** Under 60% delivered pauses the number for 48h, but only
  when its reply rate is also poor. An undelivered WhatsApp message usually means a
  dead number rather than a burnt sender, so delivery alone never pauses anything.
- **Health score.** Penalty points decayed over 24h: logged out +60, 403 +40,
  timelock (463) +25, failed send +20, connection flapping +15. At 30 the send rate
  halves, at 60 it drops fivefold, at 85 the number pauses for 24h.
- A number coming off a pause restarts warmup at day 1 instead of resuming at full
  speed.
- `onWhatsApp()` runs before every first send, so a number that has no WhatsApp
  account is marked invalid instead of burning quota.

There is no warmup-chatter feature. Having your own linked numbers message each
other to manufacture inbound traffic is borrowed from email warmup pools, is
unproven on WhatsApp, and the closed loop may itself read as a pattern, so it was
not built. `lib/wa.ts` does drop sender-to-sender traffic before it reaches the
inbox or the reply counts, so chatting between two of your own numbers by hand
cannot inflate the metric such a feature would have existed to support.

Deliberately **not** used: any third-party "anti-ban" package. In April 2026 one of
the popular ones, `lotusbail` with 56k downloads, was caught
[exfiltrating session credentials](https://www.securityweek.com/npm-package-with-56000-downloads-steals-whatsapp-credentials-data/).
It was a clone of Baileys that kept the real functionality and wrapped the socket, so
everything worked while every message and credential went to the operator. A number's session *is* its WhatsApp login, so treat it like a private
key. Sessions live in the `wa_auth` table, which means **a database dump is a dump of
your WhatsApp logins**: give `pg_dump` output the same care as a password file, and
remember that `docker compose down -v` destroys the credentials along with the data.
Nothing in the app returns, logs or exports them.

## What "warmup" actually means here

In cold email, warmup means building a sending reputation for a domain and IP: you
raise volume gradually and generate engagement, and the providers' scores improve.

**None of that mechanism exists on WhatsApp.** There is no published reputation
score, nothing to build up, and no provider to warm up with. In this app the word
means exactly one thing and nothing more:

> How fast a number's daily allowance climbs from 10 strangers a day to its ceiling.

That is worth doing because a sudden jump from no activity to bulk sending is one of
the few patterns Meta's heuristics visibly react to. It is *not* worth believing in
beyond that. A slow ramp does not earn a number trust, and no ramp compensates for
a number with no history. What actually makes a number durable is age, prior normal
use, and a real contact graph, none of which this app can manufacture. That is also
why the "warmup pool" idea (your own numbers messaging each other) is not in this
app at all. See the table below.

## What does not transfer from cold email

This project borrows its shape from cold email, but several standard email tactics
are either meaningless on WhatsApp or actively counterproductive. They are called
out here because copying them is the most common way these tools get built wrong.

| Email tactic | Why it works there | Why it doesn't here | What this does instead |
|---|---|---|---|
| **IP rotation, auto-replacing "flagged" IPs** | Reputation attaches to the sending IP and domain | Identity attaches to the *number and its linked device*. Real users roam between mobile and wifi constantly, so IP churn is normal and can't be weighed heavily. A linked-device session whose IP keeps hopping looks *more* anomalous, not less | One **sticky** proxy per number, never rotated. What actually matters is that numbers don't share an address (that correlates the accounts) and that the range looks residential rather than datacenter, so the dashboard records each number's egress IP and warns when two share one |
| **Inbox-placement / seed-list testing** | You can seed accounts across providers and measure the spam folder | There is no spam folder and no providers to seed | The number's own delivery and reply rates are the only feedback loop, plus a Test button that proves the connection end to end |
| **Delivery rate as a reputation signal** | A bounce or placement drop is reputational | An undelivered WhatsApp message usually just means the phone is off or the number is dead. It's a *list-quality* metric first | A number is paused for low delivery only when its reply rate is also poor. A number getting replies is demonstrably reaching people |
| **Warmup pools** | Providers score engagement on your domain, so pooled replies genuinely help | A closed loop of your own numbers messaging each other is unproven here, and the pattern itself could be a signal | Not built. The warmup that does matter is the ramp: few strangers per day, growing slowly |
| **Unsubscribe footers / `List-Unsubscribe`** | The standard, and expected by filters | There is no header standard, and a link in a cold first message is itself a risk factor | Opt-out by reply keyword (English and Hinglish), applied globally and permanently |
| **Open/click tracking pixels** | HTML email supports them | No HTML, no pixel | Native delivery and read receipts, which are more accurate than a pixel anyway |
| **SPF / DKIM / DMARC, domain warmup** | Authentication is the price of entry | No equivalent exists | The nearest thing to domain reputation is the number's own history and contact graph, which is why a number's provenance matters more than any setting in this app |
| **Volume benchmarks** (20–30/mailbox/day scaling to thousands) | Mailboxes are cheap and reputation scales | The binding constraint is *strangers messaged*, not messages sent | Caps count cold strangers, ~60/day/number at the default ceiling |

The single biggest factor is one this app can't control: **the number itself.** An aged
number that has been used normally, has a profile photo and real conversations in its
history, survives far longer than a freshly bought SIM that starts by messaging
strangers. No amount of pacing compensates for that.

## What the numbers mean

WhatsApp gives four per-message signals: sent, delivered, read and failed. This app
records all of them. What it deliberately does not invent:

| Metric | Real here? | Caveat |
|---|---|---|
| **Sent** | Yes | The message left your number. |
| **Delivered** | Yes | It reached the recipient's device. Low delivery usually means dead numbers in your list, not a burnt sender, which is why it only pauses a number when the reply rate is also poor. |
| **Read** | Yes, but soft | Recipients can turn read receipts off, so a low read rate does not mean nobody looked. Treat it as directional, never as a target. |
| **Reply rate** | Yes, and it is the one that matters | Counted from actual inbound messages, not inferred. It is also the strongest ban signal, which is why a number that nobody answers gets paused. |
| **Open rate** | No | There is no email-style open event on WhatsApp. Anyone quoting a "98% open rate" is quoting read receipts, or nothing at all. |
| **Click-through** | No | Would need link tracking, and a link in a cold first message is itself a risk factor. This app does not add one. |

## Settings and integrations

Everything below is configured in the dashboard's **Settings** tab. Nothing here
needs a restart or an environment variable, though the environment still works.

- **Sending limits.** Six of the ban-avoidance numbers are editable here, described
  in [How the ban-avoidance works](#how-the-ban-avoidance-works): the day-one
  allowance, how fast it ramps, the hard ceiling, how often a number rests, and the
  reply and delivery floors. The defaults are deliberately cautious; raising them is
  your risk, not a supported configuration.
- **Reply tagging.** Incoming replies are labelled interested / meeting / neutral /
  not-interested so the inbox can be triaged. A tag you set by hand is never
  overwritten. Bring your own key for **Claude, Gemini or ChatGPT**, pick any
  text-in/text-out chat model by name, and read or edit the exact prompt used to
  classify a reply. It runs on the Vercel AI SDK with plain text in and out, no
  structured-output or tool-calling modes, so a model that lacks those still works.
  Tagging is best-effort: a bad key or a provider outage leaves the reply untagged
  and never interrupts message handling.
- Export is two URLs: `/api/export?campaign=<id>` for every message with its
  delivery and reply outcome, `/api/export?list=<name>` for a list with each
  contact's status.
- **Password.** Set one in Settings, or with `APP_PASSWORD` in the environment. It
  is stored as a scrypt hash with a per-install random salt and compared in constant
  time, never as plaintext. Leave it unset and there is no auth at all, which is fine
  on localhost and nowhere else: anyone who can reach the URL can send messages from
  your WhatsApp numbers.

## Proof

```bash
npm test          # pure-function asserts: CSV, phones, spintax, request guards, safety
npm run test:flow # boots the real engine against stubbed WhatsApp and proves 16 rules
```

`test:flow` runs the actual send loop, SQL and policy with `WA_DRY_RUN=1`, then
asserts on the resulting database. It refuses to run unless `DATABASE_URL` names a
database containing "test". It proves, among others:

```
✓ hourly cap held: 0001=4 0002=5 0003=4 (cap 5 each)
✓ per-number pacing randomised: 10 gaps, 4243–6124ms, 10 distinct
✓ numbers send in parallel: global gaps down to 265ms while each number waits ≥4243ms
✓ duplicate-copy guard held (max 2/number/1h)
✓ numbers without WhatsApp skipped, not sent to
✓ follow-ups sent, always from the number that opened the thread
✓ a reply stops the sequence and shows up unread in the inbox
✓ opt-out blocklists the number globally and cancels its queue
✓ health 100 → auto-paused 24h and stopped sending
✓ reply rate below 4% after 30 sends → auto-paused 48h
✓ delivery below 60% with a weak reply rate → auto-paused
✓ low delivery alone does not pause a number that is getting replies
✓ send window respected: queue frozen outside campaign hours, drains as soon as they open
✓ cross-campaign cooldown respected: fresh lead sent, already-contacted lead held back
```

Two of those tests were written before the behaviour existed and caught real bugs:
head-of-line blocking (a lead whose sticky number was capped stalled the entire
queue) and global instead of per-number pacing (adding numbers added no throughput).

## Scale and caching

**Where this design runs out.** One process owns the sending, and a Postgres advisory
lock enforces that: start a second copy against the same database and it serves the
dashboard but refuses to send, rather than fighting the first one for the same
WhatsApp session. Baileys publishes no supported socket count, and the question has
been asked upstream and closed unanswered, so treat community reports as the only
evidence: they cluster around **50 to 200 sockets in one Node process**, with a few
gigabytes of memory at fifty and instability approaching a couple of hundred. Node is
single-threaded and encryption happens per recipient device, so the event loop gives
out before memory does.

None of that is the real limit for cold outreach. Your ceiling is the safety caps:
numbers multiplied by the daily stranger allowance. At the default ramp that is about
60 a day per number once warm, so twenty numbers is roughly 1,200 messages a day, and
you would need hundreds of numbers before the socket count mattered. If you ever do,
the pattern is sharded workers with exactly one owner per session, which is what the
advisory lock already enforces in miniature.

The seeder refuses to run unless `DATABASE_URL` names a scratch database, so it cannot
bury a real install in test data:

```bash
node scripts/seed.ts --leads 100000 --senders 20 --sent 2000000
node scripts/bench.ts
```

Measured on 100k leads, 20 numbers, **2M messages** of history, with a realistic
day's traffic (1.2k sends today):

| query | when it runs | median |
|---|---|---|
| sender caps + health | every send | **0.7 ms** |
| next due message | every tick | 0.8 ms |
| duplicate-copy guard | every send | 0.3 ms |
| inbox threads | dashboard poll | 8.6 ms |
| campaign aggregates | dashboard poll, cached 3s | 73 ms |
| lifetime totals | reply/delivery gates, cached 60s | 80 ms |

The caching rule is a single distinction:

- **Anything a cap is enforced from is never cached.** Today's and this hour's send
  counts are always read fresh, because an over-send cannot be taken back.
- **Anything statistical is cached.** Reply rate and delivery rate are judged over
  hundreds of sends, so 60s of staleness cannot change a verdict, and caching keeps
  a full-history scan off the per-send path.
- The dashboard payload is cached 3s with in-flight de-duplication
  ([`lib/cache.ts`](./lib/cache.ts)), so ten open tabs cost the same as one.

That split is what makes the hot path flat: the per-send query was originally 19ms
and grew with total history; it is now 0.7ms at 2M messages and grows only with
*today's* volume. Counters are always derived from `messages`, never stored on
`senders`, so they cannot drift.

**Throughput is limited by safety, not by the code.** Each number does roughly its
daily cap (60/day at the default ceiling), and numbers run in parallel, so ~20
numbers ≈ 1,200 messages/day. Queue size is not the constraint: 100k queued leads is
fine. The send rate is. WhatsApp cold outreach is a low-volume, high-response
channel; if you need email-style 10k/day, you need the volume on email.

## Architecture

```
app/(dashboard)/     one real route per section: /numbers /contacts /campaigns
                     /inbox /activity /settings, sharing one shell layout, plus
                     /campaigns/[id] and /contacts/[list] detail pages
app/api/             route handlers (state, senders, leads, campaigns, inbox,
                     blocklist, export, settings, login)
proxy.ts             optional password gate (Next's proxy/middleware convention)
components/          shadcn/ui panels and dialogs: import, list detail, campaign
                     builder, per-number limits, QR pairing, test send
components/data-table/  one TanStack Table v9 feature set and one table
                     component, shared by every table in the app
lib/client.ts        typed fetch, TanStack Query hooks, shared view types
lib/schema.sql       tables and idempotent migrations, applied on boot
lib/db.ts            pg pool, row types, query helpers
lib/http.ts          API error handling and the input guards routes share
lib/parse.ts         CSV sniffing, phone normalisation, {{vars}}, opt-out matching
lib/safety.ts        the entire ban-avoidance policy, as pure functions
lib/settings.ts      the one settings row: editable limits, AI keys, password hash
lib/cache.ts         TTL cache with in-flight de-duplication
lib/ai.ts            optional reply tagging
lib/wa.ts            Baileys socket per number: QR, proxy, presence, receipts, acks
lib/engine.ts        the send loop: pick message → pick free number → send → judge
instrumentation.ts   boots migrate + sockets + engine once per server process
scripts/             seed and bench
tests/flow.ts        live-engine proof of the safety rules
```

Every section is a real URL, so refresh and back work and a link points at what you
were looking at. Data is fetched through TanStack Query, so the sidebar, the header
and the page share one `/state` request, a revisited tab renders from cache while it
refetches, and a write invalidates rather than blindly refetching.

```bash
npm run typecheck    # tsc --noEmit
npm run lint
npm run build
```

## Contributing to the UI

The dashboard is shadcn/ui on Tailwind 4, and a few conventions are enforced by
review rather than by a linter. If you send a PR, these are the ones that get
comments:

**Every table is the shared `DataTable`.** `components/data-table/` holds one
TanStack Table v9 feature set and one table component, so sorting, filtering,
pagination and column show/hide behave identically on every screen. Define
columns with `createColumnHelper<TableFeatures, Row>()`, give each header a
`SortableHeader` (or `PlainHeader`) with its `tooltip`, and pass the empty state
through the `empty` prop.

Two v9 details that trip people up:

- `table.getState()` was removed. Pagination state is held in the component
  alongside sorting and filters.
- `Column` is invariant in its value type, so accessors are annotated
  `(row): unknown =>`. A `number` accessor will not fit a header typed against
  `Column<TableFeatures, Row>`.

`DataTable`'s filter is client-side. Where a list is paginated server-side (the
contacts inside a list), search stays server-side too. A client filter there
would search only the loaded page and quietly report the wrong count.

**No spinners.** Loading is stated in words: a busy button keeps its icon and
changes its label to "Sending…", a loading pane says "Loading contacts…". A
spinning ring says something is happening; the text says what.

**No coloured toast fills, and no `alert()` or `confirm()`.** Toasts use the
neutral popover surface. Anything destructive goes through `ConfirmButton`.

**No em dashes in user-visible strings.** Use a period, a comma, a colon or
parentheses. En dashes in numeric ranges are fine.

**Every metric carries a tooltip** in one plain sentence. Someone who has never
run an outreach campaign has to be able to read this dashboard, so a column
header that needs domain knowledge to interpret is a bug.

## Roadmap

Media and attachment steps, multi-user workspaces (there is a single shared password
today, not accounts), and a Meta Cloud API adapter so the same sequences can run on
the official API where you have opt-in.

Deliberately **not** on the roadmap, per [What does not transfer](#what-does-not-transfer-from-cold-email):
automatic IP rotation and inbox-placement testing. Both are email ideas that would
add moving parts without making a WhatsApp number any safer.

## License

MIT. See [LICENSE](./LICENSE). No warranty, and no responsibility for banned
numbers or how you use it.
