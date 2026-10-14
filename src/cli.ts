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
import { embed, toVector, embeddingsEnabled } from "./lib/embed.ts";
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
  let total = 0;

  for (;;) {
    const rows = await q<{ object_type: string; object_id: string; space_id: string; sensitivity: string; content: string }>(
      `SELECT * FROM embedding_backlog LIMIT $1`, [batchSize],
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

  const bitdeer = await callTool("recall", { query: "the" }, "selftest");
  check("a default search never reaches Bitdeer",
    !/"space_id": "bitdeer"/.test(bitdeer.content[0]!.text));

  // Clean up.
  await q(`DELETE FROM decisions WHERE title = $1`, [marker]);
  await q(`DELETE FROM events WHERE external_id = $1`, [marker]);
  await q(`DELETE FROM entities WHERE name = 'Self Test'`);

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
