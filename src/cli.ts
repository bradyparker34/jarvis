#!/usr/bin/env node
/**
 * jarvis <command>
 *
 *   migrate    create or update the schema
 *   ingest     pull in everything waiting in inbox/, plus iMessage if asked
 *   embed      compute embeddings for anything new (safe to re-run)
 *   serve      start the HTTP bridge
 *   doctor     what is connected, what is stale, what needs a human
 *   test       end-to-end check against the live database
 */

import { q, one, migrate, hasVectors, close, repoRoot } from "./lib/db.ts";
import { embed, toVector, embeddingsEnabled, embeddingIsLocal, embedProvider } from "./lib/embed.ts";
import { ingestDropFolder } from "./adapters/drop.ts";
import { ingestIMessage } from "./adapters/imessage.ts";
import { inferEdgesFromParticipation } from "./lib/ingest.ts";
import { suggestMerges } from "./lib/identity.ts";
import { join } from "node:path";

const [, , command, ...rest] = process.argv;
const flag = (name: string): string | undefined => {
  const index = rest.indexOf(`--${name}`);
  return index === -1 ? undefined : rest[index + 1];
};
const has = (name: string) => rest.includes(`--${name}`);

async function cmdMigrate() {
  const { applied, skipped } = await migrate();
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "schema already current");
  for (const s of skipped) console.warn(`skipped: ${s}`);
  const spaces = await q<{ id: string; label: string }>("SELECT id, label FROM spaces ORDER BY id");
  console.log(`spaces: ${spaces.map((s) => s.id).join(", ")}`);
  console.log(`semantic search: ${(await hasVectors()) ? "on" : "off (pgvector not installed)"}`);
}

async function cmdIngest() {
  const me = flag("me") ?? process.env.JARVIS_ME;
  const addresses = (flag("addresses") ?? process.env.JARVIS_ADDRESSES ?? "")
    .split(",").map((a) => a.trim()).filter(Boolean);

  const reports = await ingestDropFolder({ me, myAddresses: addresses });
  if (!reports.length) {
    console.log(`nothing waiting in ${join(repoRoot, "inbox")}/<space>/`);
  }
  for (const r of reports) {
    console.log(`${r.space}  ${r.file}  via ${r.via}: ${r.created} new of ${r.seen}`);
  }

  if (has("imessage")) {
    const space = flag("space") ?? "personal";
    const days = Number(flag("days") ?? 365);
    try {
      const out = await ingestIMessage({ spaceId: space, sinceDays: days });
      console.log(`imessage -> ${space}: ${out.created} new of ${out.seen}`);
    } catch (err) {
      console.error(`imessage failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error("Grant Full Disk Access to your terminal in System Settings, Privacy & Security.");
    }
  }

  const edges = await inferEdgesFromParticipation();
  console.log(`relationships refreshed: ${edges}`);
  if (embeddingsEnabled()) console.log("run `jarvis embed` to make the new material semantically searchable");
}

async function cmdEmbed() {
  if (!(await hasVectors())) {
    console.log("pgvector is not installed, so there is nothing to embed. Keyword search still works.");
    return;
  }
  const model = process.env.EMBED_MODEL ?? "all-MiniLM-L6-v2";
  const batchSize = Number(flag("batch") ?? 64);
  const local = embeddingIsLocal();
  let total = 0;
  let withheld = 0;

  // A remote provider may only see rows that are safe to send off this
  // machine: 'open' or 'private', and from a space that is not confidential by
  // construction. Everything else is refused up front rather than skipped
  // quietly, because a silent skip means Bitdeer never becomes searchable and
  // nobody finds out why.
  if (!local) {
    const [sensitive] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM embedding_backlog b
         WHERE NOT (b.sensitivity <= 'private' AND b.space_id = ANY(exportable_spaces()))`,
    );
    const n = sensitive?.n ?? 0;
    if (n > 0 && !has("allow-withholding")) {
      console.error(
        `EMBED_PROVIDER=${embedProvider()} sends text to a third party, and ${n} row(s) waiting to be\n` +
        `embedded are confidential, restricted, or in a space marked unshareable.\n\n` +
        `Refusing the whole run. Pick one:\n` +
        `  EMBED_PROVIDER=local        embed everything on this machine (recommended)\n` +
        `  jarvis embed --allow-withholding   embed only the exportable rows, leave the rest unembedded\n\n` +
        `See docs/RISKS.md.`,
      );
      process.exitCode = 1;
      return;
    }
    withheld = n;
  }

  for (;;) {
    // The filter lives in the query, not in the loop below, so a future caller
    // cannot reintroduce the leak by forgetting to check.
    const rows = await q<{ object_type: string; object_id: string; space_id: string; sensitivity: string; content: string }>(
      `SELECT * FROM embedding_backlog b
         WHERE $2::boolean
            OR (b.sensitivity <= 'private' AND b.space_id = ANY(exportable_spaces()))
         LIMIT $1`,
      [batchSize, local],
    );
    if (!rows.length) break;

    const vectors = await embed(rows.map((r) => r.content ?? ""));
    if (!vectors.length) {
      console.warn("embedding model unavailable; stopping. Keyword search is unaffected.");
      break;
    }

    for (const [i, row] of rows.entries()) {
      const vector = vectors[i];
      if (!vector) continue;
      await q(
        `INSERT INTO embeddings (object_type, object_id, model, embedding, space_id, sensitivity)
         VALUES ($1,$2,$3,$4::vector,$5,$6)
         ON CONFLICT (object_type, object_id, model) DO NOTHING`,
        [row.object_type, row.object_id, model, toVector(vector), row.space_id, row.sensitivity],
      );
    }
    total += rows.length;
    process.stdout.write(`\rembedded ${total}`);
  }
  console.log(`\ndone: ${total} embedded with ${model}`);
  if (withheld) {
    console.log(
      `withheld from ${embedProvider()}: ${withheld} confidential/restricted/unshareable row(s).\n` +
      `They stay keyword-searchable only. Switch to EMBED_PROVIDER=local to include them.`,
    );
  }
}

async function cmdDoctor() {
  const vectors = await hasVectors();
  const [sources, counts, loops, dupes, stale] = await Promise.all([
    q(`SELECT space_id, kind, handle, last_synced_at, enabled FROM sources ORDER BY space_id, kind`),
    q(`SELECT s.id AS space,
              (SELECT count(*) FROM events e WHERE e.space_id = s.id) AS events,
              (SELECT count(*) FROM claims c WHERE c.space_id = s.id AND c.superseded_by IS NULL) AS facts,
              (SELECT count(*) FROM decisions d WHERE d.space_id = s.id) AS decisions
       FROM spaces s ORDER BY s.id`),
    q(`SELECT count(*)::int AS n FROM open_loops`),
    suggestMerges(5),
    q(`SELECT count(*)::int AS n FROM embedding_backlog`).catch(() => [{ n: 0 }]),
  ]);

  console.log("\nspaces");
  for (const c of counts as any[]) {
    console.log(`  ${c.space.padEnd(12)} ${String(c.events).padStart(7)} events  ${String(c.facts).padStart(5)} facts  ${String(c.decisions).padStart(4)} decisions`);
  }

  console.log("\nfeeds");
  if (!(sources as any[]).length) console.log("  none connected yet — drop a file in inbox/<space>/ to start");
  for (const s of sources as any[]) {
    const when = s.last_synced_at ? new Date(s.last_synced_at).toISOString().slice(0, 10) : "never";
    console.log(`  ${s.space_id.padEnd(12)} ${s.kind.padEnd(16)} ${String(s.handle).slice(0, 30).padEnd(32)} ${when}`);
  }

  console.log(`\nsemantic search: ${vectors ? "on" : "off (pgvector missing)"}`);
  if (vectors) console.log(`waiting to embed:  ${(stale as any[])[0]?.n ?? 0}  (run: jarvis embed)`);
  console.log(`decisions overdue for a verdict: ${(loops as any[])[0]?.n ?? 0}  (ask an agent for 'review')`);

  if ((dupes as any[]).length) {
    console.log("\npossible duplicate people (merge manually, never automatically):");
    for (const d of dupes as any[]) console.log(`  ${d.a_name}  ${d.a}  <->  ${d.b}`);
  }
  console.log();
}

async function cmdServe() {
  await import("./mcp/http.ts");
}

/** End-to-end check against the live database. Cleans up after itself. */
async function cmdTest() {
  const marker = `jarvis-selftest-${Date.now()}`;
  let failures = 0;
  const check = (name: string, pass: boolean) => {
    console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
    if (!pass) failures++;
  };

  const { ingestEvent } = await import("./lib/ingest.ts");
  const { callTool } = await import("./mcp/tools.ts");

  const event = await ingestEvent({
    spaceId: "personal",
    kind: "note",
    occurredAt: new Date(),
    externalId: marker,
    subject: marker,
    body: `self test ${marker} pangolin`,
    participants: [{ kind: "email", value: `${marker}@example.com`, name: "Self Test" }],
  });
  check("ingest creates an event", event.created);

  const again = await ingestEvent({
    spaceId: "personal", kind: "note", occurredAt: new Date(),
    externalId: marker, subject: marker, body: "duplicate",
  });
  check("re-ingesting the same id does not duplicate", !again.created && again.id === event.id);

  const found = await callTool("recall", { query: "pangolin", spaces: ["personal"] }, "selftest");
  check("recall finds it", found.content[0]!.text.includes(marker));

  const who = await callTool("who_is", { name: `${marker}@example.com` }, "selftest");
  check("who_is resolves by email address", who.content[0]!.text.includes("Self Test"));

  const decision = await callTool("log_decision", {
    space: "personal", title: marker, question: "self test?", chosen: "YES",
    prediction_metric: "days", prediction_value: 10, confidence: 0.6,
  }, "selftest");
  const decisionId = JSON.parse(decision.content[0]!.text).decision_id;
  check("log_decision returns an id", Boolean(decisionId));

  const outcome = await callTool("record_outcome", {
    decision_id: decisionId, metric: "days", actual: 5, lower_is_better: true,
  }, "selftest");
  check("record_outcome grades a faster result as better",
    JSON.parse(outcome.content[0]!.text).verdict === "better");

  // ------------------------------------------------- the Bitdeer boundary
  //
  // The old check below only exercised `recall`, which was never the problem:
  // it goes through a SQL function that honours the boundary. The leaks were in
  // handlers that wrote their own queries — who_is returned Bitdeer bodies even
  // when asked for one other space by name. So these checks plant real
  // unshareable material and probe every read path for it.
  //
  // Everything planted here is marked and removed in the finally block below.
  const { resolveScope, graphSnapshot } = await import("./mcp/tools.ts");
  // Two separate tokens on purpose. `canary` is the search term, and the
  // not-found reply quotes the search term back, so probing for it would
  // report a leak on an empty result. The secrets only ever appear inside row
  // bodies and titles, so finding one means a row actually came back.
  const canary = `${marker}-CANARY`;
  const secret = `${marker}-CONFIDENTIAL-BODY`;
  const restrictedSecret = `${marker}-RESTRICTED-BODY`;

  try {
    const source = await one<{ id: string }>(
      `INSERT INTO sources (space_id, kind, handle) VALUES ('bitdeer','manual',$1)
       ON CONFLICT (kind, handle, space_id) DO UPDATE SET enabled = sources.enabled
       RETURNING id`, [marker],
    );
    for (const [n, sensitivity, body] of [
      ["c", "confidential", secret],
      ["r", "restricted", restrictedSecret],
    ] as const) {
      await ingestEvent({
        spaceId: "bitdeer", sourceId: source!.id, kind: "email", occurredAt: new Date(),
        externalId: `${marker}-${n}`, subject: `${canary} ${n}`,
        body: `${canary} ${body} must never leave the bitdeer space`,
        sensitivity,
        participants: [{ kind: "email", value: `${marker}@example.com`, name: "Self Test" }],
      });
    }
    await q(
      `INSERT INTO decisions (space_id, title, question, chosen, status, decided_by, decided_at)
       VALUES ('bitdeer',$1,'self test?','YES','executed','selftest', now())`, [secret],
    );

    const leaks = (result: { content: { text: string }[] }) =>
      result.content[0]!.text.includes(secret) || result.content[0]!.text.includes(restrictedSecret);

    check("recall at default scope never reaches Bitdeer",
      !leaks(await callTool("recall", { query: canary }, "selftest")));
    check("who_is at default scope never reaches Bitdeer",
      !leaks(await callTool("who_is", { name: `${marker}@example.com` }, "selftest")));
    check("who_is scoped to one space never reaches another",
      !leaks(await callTool("who_is", { name: `${marker}@example.com`, spaces: ["personal"] }, "selftest")));
    check("timeline at default scope never reaches Bitdeer",
      !leaks(await callTool("timeline", {}, "selftest")));
    check("review with no space never reaches Bitdeer",
      !leaks(await callTool("review", {}, "selftest")));
    check("the viewer graph at default scope never reaches Bitdeer",
      !JSON.stringify(await graphSnapshot(await resolveScope({}))).includes("bitdeer"));

    // Named outright, it must still answer — that is the documented escape
    // hatch, and a boundary that cannot be opened deliberately is just a bug.
    check("Bitdeer still answers when named explicitly",
      leaks(await callTool("recall", { query: canary, spaces: ["bitdeer"] }, "selftest")));

    // Restricted is the one level that is never readable, by any caller.
    const named = await callTool("recall", { query: canary, spaces: ["bitdeer"] }, "selftest");
    check("restricted material is withheld even from an explicit Bitdeer read",
      named.content[0]!.text.includes(secret)
      && !named.content[0]!.text.includes(restrictedSecret));

    // A mistyped space must raise, not resolve to an empty set that reads as
    // "nothing known".
    const typo = await callTool("recall", { query: canary, spaces: ["bitdeerr"] }, "selftest");
    check("an unknown space id is an error, not silence",
      Boolean(typo.isError) && typo.content[0]!.text.includes("unknown space"));

    // Blending arenas has to be asked for. A single named space does not.
    const blended = await callTool("recall",
      { query: canary, spaces: ["bitdeer", "personal"] }, "selftest");
    check("naming two spaces without cross_space is refused",
      Boolean(blended.isError) && blended.content[0]!.text.includes("cross_space"));

    const deliberate = await callTool("recall",
      { query: canary, spaces: ["bitdeer", "personal"], cross_space: true }, "selftest");
    check("naming two spaces with cross_space works",
      !deliberate.isError && deliberate.content[0]!.text.includes(secret));

    const single = await callTool("recall", { query: canary, spaces: ["personal"] }, "selftest");
    check("a single named space needs no cross_space", !single.isError);
  } finally {
    // Clean up, including anything planted before a check threw.
    await q(`DELETE FROM decisions WHERE title IN ($1, $2)`, [marker, secret]);
    await q(`DELETE FROM events WHERE external_id LIKE $1`, [`${marker}%`]);
    await q(`DELETE FROM sources WHERE handle = $1`, [marker]);
    await q(`DELETE FROM entities WHERE name = 'Self Test'`);
  }

  console.log(failures ? `\n${failures} failed` : "\nall checks passed");
  process.exitCode = failures ? 1 : 0;
}

const commands: Record<string, () => Promise<void>> = {
  migrate: cmdMigrate,
  ingest: cmdIngest,
  embed: cmdEmbed,
  doctor: cmdDoctor,
  serve: cmdServe,
  test: cmdTest,
};

const run = commands[command ?? ""];
if (!run) {
  console.log("usage: jarvis <migrate|ingest|embed|serve|doctor|test>");
  process.exit(1);
}

try {
  await run();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  if (command !== "serve") await close();
}
