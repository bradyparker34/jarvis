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
`include_confidential: false` on a `recall` call keeps it out of anything being
drafted for an outside reader.

**The sever switch.** `DELETE FROM spaces WHERE id = 'bitdeer';` cascades to
every event, claim, edge and embedding in that space. One statement, no
migration.

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
