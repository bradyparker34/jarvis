# Jarvis

A personal context graph. Everything that enters your working life — messages,
email, meetings, notes, decisions — in one local database that any AI agent can
query, with the one thing most "second brain" systems leave out: a record of
what you decided, what you expected, and what actually happened.

Runs entirely on your own machine. Nothing is sent anywhere.

---

## Why this shape

Most memory systems are a search box over a pile of text. That is useful, and it
is not what makes an agent good at your job. Three things here are deliberate:

**Events are immutable; facts are separate.** Raw messages go into an append-only
log. Distilled facts — "pays by wire", "needs 30 days", "approves above 15%" —
live as *claims*, each pointing back at the message that produced it. Claims
supersede each other, so the system can change its mind without losing why it
used to think otherwise. An agent can always answer *how do you know that*.

**Spaces are isolated by default.** Bitdeer, meat, watches and personal are
separate arenas. A query that does not name a space searches everything
shareable. Bitdeer is marked unshareable in the database, so it only answers
when asked for by name, and a cross-space sweep can never pull it in by
accident.

**Decisions are graded.** Logging a decision records the context behind it and
what you expected. Recording the outcome grades it automatically. Over a few
months this answers questions nothing else can: which sources produce deals that
underperform, and whether your 90% confidence is actually 90%.

---

## Quickstart

```bash
cp .env.example .env          # set JARVIS_HTTP_TOKEN: openssl rand -hex 32
docker compose up -d          # Postgres 17 with pgvector, on 127.0.0.1:5464
npm install
npm run db:migrate            # schema + the four spaces
npm run doctor                # what is connected, what is stale
```

Then put something in it:

```bash
mkdir -p inbox/scottsdale
# drop a WhatsApp export, a transcript, a note, an mbox, anything
npm run ingest
npm run embed                 # makes it semantically searchable
```

And look at it:

```bash
npm run serve                 # http://127.0.0.1:8787 — the 3D map
```

---

## Getting your life into it

Ordered by value per hour of setup. The drop folder handles most of it: put a
file in `inbox/<space>/`, run `npm run ingest`, and it is dispatched by type.

| Source | How | Status |
|---|---|---|
| **Anything text** | Drop in `inbox/<space>/` | Works now |
| **WhatsApp** | Chat → Export chat → Without media | Works now |
| **Telegram** | Desktop → Settings → Advanced → Export, JSON | Works now |
| **Email** | takeout.google.com → Mail → mbox | Works now |
| **iMessage / SMS** | `npm run ingest -- --imessage --space personal` | Works now, macOS, needs Full Disk Access |
| **Meeting transcripts** | Drop the file; named with "transcript" or "meeting" | Works now |
| **Slack** | Workspace export, or a user token | Export works; live needs a token |
| **Live Gmail sync** | Gmail API | Not built — Takeout covers the history |
| **Calls** | A recorder that writes transcripts to the drop folder | Not built; read `docs/RISKS.md` first |

The export route is not a workaround. For WhatsApp it is the *only* legitimate
route — every library claiming live access to a personal account breaks their
terms and gets numbers banned. For email, Takeout gets ten years of history in
one file with no OAuth app to maintain and no token to leak.

---

## Connecting your agents

**Claude Desktop, Claude Code, Cursor** — see `docs/CONNECTING.md`. One block of
JSON; the server runs as a subprocess over stdio.

**Anything else** — `npm run serve` exposes an HTTP bridge on localhost with a
bearer token. `GET /tools` lists the surface, `POST /tools/<name>` calls one.

The tools your agents get:

| Tool | For |
|---|---|
| `recall` | Search everything. Hybrid keyword + semantic. |
| `who_is` | Full dossier on a person or company before you contact them. |
| `timeline` | What happened over a window. |
| `graph` | Who connects to whom, and how you reach someone. |
| `remember` | Write a durable fact into the graph. |
| `log_decision` | Record a call, its context, and what you expect. |
| `record_outcome` | Say what happened. Grades it against the prediction. |
| `review` | Hit rate, calibration, and decisions overdue for a verdict. |
| `spaces` | What arenas exist and how much is in each. |

---

## Daily use

```bash
npm run ingest && npm run embed    # whatever you have dropped in
npm run doctor                     # staleness, duplicates, overdue decisions
```

Worth doing from an agent, weekly: ask it to run `review`. If the calibration
table shows your 90% bucket landing at 60%, every agent trusting your stated
confidence has inherited that error.

---

## What is actually verified

The schema, the ingest path, hybrid retrieval and the decision loop are tested
end to end against real Postgres — `npm run db:test` runs those checks against
your own database, and `db/test/smoke.sql` covers space isolation, the Bitdeer
boundary, provenance and outcome grading in both directions.

Not yet exercised against real volume: a multi-gigabyte Takeout mbox, and the
iMessage reader against a large `chat.db`. Both stream rather than buffer, but
treat the first run of each as a test.

---

## Layout

```
db/migrations/   schema, in order; 003 is optional (needs pgvector)
db/seed/         the four spaces
db/test/         SQL smoke test
src/lib/         db, embeddings, identity resolution, ingest
src/mcp/         the tool surface, stdio server, HTTP bridge
src/adapters/    WhatsApp, Telegram, iMessage, mbox, drop folder
viewer/          the 3D map
docs/            connecting agents, ingestion detail, risk register
```

Read `docs/RISKS.md` before connecting employer systems or recording calls.
