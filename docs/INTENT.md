# What Jarvis is for

Brady's answers, 2026-10-14. This is the intent the build serves. Where an
answer and the current code disagree, the gap is written down at the bottom
rather than quietly resolved.

## The two jobs

1. **Decide with context no human could hold.** Answer a question using
   historical material Brady has no way of recalling — a term agreed eighteen
   months ago, what a counterparty said they needed, what happened last time a
   similar call was made.
2. **Triage everything incoming and advise.** Read what arrives across every
   channel and say what to do next, against that same history.

Today the alternative is digging through Slack, email, Telegram, WhatsApp,
texts, Wispr Flow and Granola by hand, or asking an agent to search each
connected app one at a time. That works and is entirely manual.

Jarvis is **answer, plan, and act** — chief of staff, not a search box. It
drafts, it takes actions, and it hands work to agents where that helps.

## Where it sits

Jarvis is the hive mind and the system of record. It does the gathering,
storage, and action. Everything else consumes it.

- **Replaces** the n8n assistant, which is no longer in use.
- **WatchTrader Pro** and **MeatTrader Pro** keep doing what they do. Jarvis
  feeds them — it pushes each one the material for its own arena and keeps the
  rest. Neither may receive the other's data; cross-contamination there is a
  stated failure condition, not a nuisance.
- **Grokbot** is the other agent in the picture and reads and writes alongside
  Claude.
- Nothing depends on Jarvis yet. It is purely additive today, which is why now
  is the time to settle the shape.

Previously the system of record was "Brady's head, or an agent searching the
connected apps on demand."

## Arenas and their sources

Separation between these is the hard requirement. Leaking between businesses is
the first failure Brady named.

| Arena | Sources |
|---|---|
| `bitdeer` | Google Workspace (Gmail, Calendar, Drive), Slack, WhatsApp, Telegram, texts, meeting transcripts from Wispr Flow, Granola and Plaud |
| `lawrence` | Outlook email, the existing Lawrence Wholesale app and database |
| `scottsdale` | Shopify, the Scottsdale Watch app including banking, Google Workspace |
| `personal` | Personal Google account, Adapt Nutrition Outlook (Shopify + email; winding down but fully operational) |

Accounts, with rough age: Bitdeer Google (1 year), personal Google (many years
— snapshot two if the volume is unreasonable), Lawrence Wholesale Outlook
(new), Scottsdale Watch Google Workspace (new), Adapt Nutrition Outlook (~2
years).

No categories of material are excluded at this time.

## Capture is meant to be automatic

The intent is not "Brady maintains it." Everything he receives is captured and
fed in without his involvement: meetings via Wispr Flow, calls via Plaud,
and Slack, email, Telegram, WhatsApp and texts flowing in directly. Manual
feeding is itself one of the named reasons he would abandon the system.

This is the largest gap between intent and the current build, which is
export-and-drop-folder throughout.

## The decision loop

Agents record decisions and outcomes continuously. The premise: the system
compounds because it sees which judgements were right, and gets better as it
goes. All four arenas participate.

What gets measured:

| Arena | Metric |
|---|---|
| `scottsdale` | Highly measurable already — days to sell, margin |
| `lawrence` | Loads sold, gross profit |
| `bitdeer` | MW signed; progress advancing co-mining contracts toward signature |
| `personal` | Basic productivity; nothing missed |

Note the feedback loops differ by an order of magnitude. A watch sells in weeks;
a JMA advances over quarters. Calibration will be meaningful for `scottsdale`
long before it means anything for `bitdeer`.

## What failure looks like

In Brady's order:

1. Information bleeding between businesses.
2. Answering from stale information and acting on it. He expects to check the
   system's work early on, but not forever — the long-run goal is not having to.
3. Capture being hard, or tracking his own information being hard.
4. Drafting and acting badly enough that the system adds friction instead of
   removing it.

## Open decisions

**Where it runs.** Unsettled, and the most consequential question on the list.
The system was built local-first — Docker Postgres on Brady's machine, local
CPU embeddings, nothing sent anywhere — and `docs/RISKS.md` is written around
that property. Supabase is now under consideration because WatchTrader Pro and
MeatTrader Pro already use it and because Brady wants access from more than one
device.

These are not interchangeable for `bitdeer`. Keeping an employer's confidential
material on a personal laptop is one thing; uploading it to a third-party SaaS
account is a different act with a different character in a dispute. The
recommendation on file is a split: Jarvis core stays local and holds everything,
and per-arena projections are pushed to Supabase for the apps that need them,
with `bitdeer` never leaving the machine. Multi-device access is solved by
reaching the local instance, not by relocating the data.

**Two machines.** Brady has a work computer holding the Bitdeer material and a
personal computer for everything else. Splitting along that line is stronger
than any software boundary — `bitdeer` data that is never on the personal
machine cannot leak from it — but it changes the shape of the system, and the
choice depends on whether the work machine is company-issued and managed.
Unresolved; see the note below on sanctioned links, because the two questions
are the same question.

**Sanctioned cross-arena links.** Compartmentalisation is the hard rule, but
some genuine connections cross arenas: the same person in two businesses, an
introduction that came from one and paid off in another. Those are legitimate
and should be expressible. What must not happen is content bleeding — Bitdeer
terms surfacing while drafting for Lawrence.

The current model half-covers this. Entities are global, so identity already
spans arenas; `entity_spaces` records where someone appears; and claims, events
and the dossier are space-filtered, so facts stay put. What is missing is a
deliberate, recorded link: a way to say "these two things are connected, here is
why" that an agent can see and reason about without that link becoming a channel
for the underlying material. A connection should be an assertion with a reason
and an author, not a side effect of a query.

**Claim extraction over `bitdeer`.** Settled: yes. A model may read Bitdeer
material to distil durable facts from it, because that is what produces the
compounding intelligence the system exists for. The model must be local, and
that restriction is not overridable by configuration — the same mistake as the
embedding provider switch, which shipped as one env var away from sending the
archive to a third party.

**Per-agent scope.** With more than one agent holding a bridge token, any caller
can name any space. Scoping tokens per agent is not built and probably should be
before Grokbot is pointed at this.

## Known gaps between this and the build

- **Capture is manual.** Everything is export-and-drop-folder. The intent is
  continuous automatic ingestion from every source above. This is the roadmap,
  not a detail.
- **No Outlook adapter.** Two of five accounts are Microsoft. Only mbox and
  Google Takeout exist.
- **WhatsApp cannot be automated legitimately.** There is no API for a personal
  account, and every library claiming otherwise breaks the terms and gets
  numbers banned. Export is the only lawful route, so this one source stays
  manual however much the rest is automated.
- **No texts path on Windows.** The iMessage adapter reads a macOS `chat.db`.
  Brady is on Windows.
- **No Shopify, Slack live, Plaud, Granola or Wispr Flow adapters.**
- **No claim extraction**, which is what turns captured material into the
  compounding intelligence described above.
- **Call recording spans jurisdictions.** Plaud and Wispr Flow capture calls and
  meetings continuously, including participants who have not consented and in
  places with all-party consent rules. Brady travels; the rule follows the
  participants. See `docs/RISKS.md`.
