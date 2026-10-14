# Risk register

Read this before connecting employer systems or recording calls. These are not
hypotheticals; each one has bitten someone.

## Employer data

Piping an employer's email, chat and deal documents into a personal database you
own is the highest-exposure thing this system can do.

- Most employment agreements and acceptable-use policies prohibit bulk copying
  of company material to personal systems. Automated and comprehensive copying
  is worse in a dispute than an ad-hoc forward, not better: it reads as
  systematic.
- Commercially sensitive counterparty terms are usually the employer's
  confidential information, and often a counterparty's too under an NDA the
  employer signed. Your having had access does not make it yours to retain.
- If you leave, the obligation to return or destroy company material is
  typically explicit. A personal graph that has absorbed it is hard to unpick.

**What the system does about it.** The `bitdeer` space is created with
`shareable = false` and `default_sensitivity = 'confidential'`. Cross-space
searches cannot reach it. Agents must name it explicitly. Setting
`include_confidential: false` on a read keeps it out of anything being drafted
for an outside reader, and material marked `restricted` is never returned to
any caller at all.

**How that is actually enforced.** Every read path resolves its scope through
one function — `resolveScope` in `src/mcp/tools.ts`, over `resolve_scope()` in
the database — and then filters on the list it returns. Handlers are given a
resolved space list rather than the caller's raw arguments, specifically so
that a new tool cannot forget to filter.

That structure exists because the earlier version did not have it, and four
read paths got it wrong: `who_is` returned Bitdeer event bodies — including
`restricted` ones — even when asked for one other space by name; `GET /graph`
rendered the whole graph whenever the `spaces` parameter was omitted, which was
the viewer's default view; an unscoped `review` returned Bitdeer decision
titles, terms and stakes. The SQL functions were correct throughout; the
hand-written queries beside them were not. `npm run db:test` now probes every
read path with planted unshareable material, so the next one that forgets fails
a test instead of leaking quietly.

**Embeddings and third parties.** `EMBED_PROVIDER=local` keeps everything on
this machine. Setting it to `openai` sends row text to OpenAI, so the embed
worker refuses to run at all while anything confidential, restricted, or in an
unshareable space is waiting to be embedded. `jarvis embed
--allow-withholding` proceeds with the exportable rows only and reports what it
held back. Note that the *query* you search with is still sent to the provider
on every `recall`, which is reason enough to leave this on `local`.

**The sever switch.** `DELETE FROM spaces WHERE id = 'bitdeer';` cascades to
every event, claim, edge, decision and embedding in that space. One statement,
no migration.

It is not a complete erase, and it is worth knowing exactly what survives:

- `entities` and `identifiers` have no space column, so every Bitdeer-only
  counterparty's name, aliases, email addresses and phone numbers remain. The
  content is gone; the address book of who the counterparties were is not.
- `retrievals` rows survive with their `query` text and `spaces` array, so the
  log of what was asked about that space outlives the space.
- `artifacts` rows cascade, but the files they point at on disk do not. Only
  the index is removed.

Closing those is a migration that has not been written yet. Until it is, treat
the sever switch as "removes the material, leaves the map of it".

**What it cannot do.** None of this changes what your agreement says. Check it.

## Recording calls

Consent law varies by jurisdiction and follows the participants, not you.

- Arizona is one-party consent: you may record a call you are part of.
- California, Florida, Pennsylvania, Washington and others require all parties
  to consent. Recording an inbound call from one of those states can be a
  criminal offence.
- The EU adds a separate layer: GDPR treats a recording as personal data
  processing and generally requires a lawful basis and notice.

A blanket "record everything" rule will eventually record a call it should not
have. Announce recording, or record selectively.

## Other people's data

Your messages are full of other people's personal information, and in some cases
their health, finances and family circumstances.

- Under GDPR, EU-based contacts have rights over data you hold about them —
  including access and erasure — and a personal database is not automatically
  exempt. The household exemption is narrower than people assume and does not
  cover commercial use.
- Think about what an agent might repeat. Facts extracted from a private message
  can surface later in a draft to a different person.

Practical defences: keep personal material in the `personal` space, mark
anything genuinely sensitive `restricted` so it never reaches a model prompt,
and prefer `include_confidential: false` when drafting anything outbound.

## WhatsApp

There is no legitimate API for a personal account. Libraries that drive the web
client or a reverse-engineered socket breach the terms of service, and bans are
routine and permanent. Export is the supported route and is what this repo uses.

## The database itself

It holds everything. Encrypt the disk (FileVault), keep the Postgres port bound
to `127.0.0.1` as shipped, never put `JARVIS_HTTP_TOKEN` in a repo, and think
twice before exposing the bridge through any tunnel.

Back it up — `pg_dump` to an encrypted volume. A backup of this database is as
sensitive as the database.

## Where perfect recall stops helping

Worth saying plainly, because it shapes what to build next.

Total capture has sharply diminishing returns. The marginal value of the ten
thousandth group-chat message is near zero, while it adds noise every retrieval
has to rank past. What compounds is the **decision and outcome loop**: a hundred
graded decisions will make your agents better at your business than a million
ingested messages, because that is the only data that says which judgements were
right.

If attention is limited, spend it on logging decisions properly — with inputs
and a prediction — rather than on connecting one more feed.
