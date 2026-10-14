/**
 * iMessage and SMS from the macOS message database.
 *
 * Reads a COPY of ~/Library/Messages/chat.db. Never the live file: it is open
 * and WAL-journalled while Messages runs, and reading it directly can corrupt
 * it. Terminal needs Full Disk Access in System Settings, Privacy & Security.
 *
 * Requires the sqlite3 binary, which ships with macOS.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateSource, ingestEvent, type Sensitivity } from "../lib/ingest.ts";

const run = promisify(execFile);

// Apple counts nanoseconds from 2001-01-01. Older rows are in seconds.
const APPLE_EPOCH = 978_307_200_000;
const appleToDate = (value: number) =>
  new Date(value > 1e12 ? value / 1e6 + APPLE_EPOCH : value * 1000 + APPLE_EPOCH);

export async function ingestIMessage(opts: {
  dbPath?: string;
  spaceId: string;
  sinceDays?: number;
  sensitivity?: Sensitivity;
}): Promise<{ seen: number; created: number }> {
  const source = opts.dbPath ?? join(process.env.HOME ?? "", "Library/Messages/chat.db");
  const copy = join(tmpdir(), `jarvis-chat-${Date.now()}.db`);
  await copyFile(source, copy);

  const sinceDays = opts.sinceDays ?? 3650;
  const sql = `
    SELECT m.ROWID, m.date, m.is_from_me, m.text,
           COALESCE(h.id, '') AS handle,
           COALESCE(c.chat_identifier, '') AS chat
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE m.text IS NOT NULL AND m.text <> ''
      AND m.date / 1000000000 + 978307200 > strftime('%s','now') - ${sinceDays * 86400}
    ORDER BY m.date`;

  // -json keeps embedded newlines and commas intact, which a CSV dump does not.
  const { stdout } = await run("sqlite3", ["-json", copy, sql], { maxBuffer: 512 * 1024 * 1024 });
  const rows: any[] = stdout.trim() ? JSON.parse(stdout) : [];

  const sourceId = await getOrCreateSource(opts.spaceId, "imessage", "local");
  let created = 0;

  for (const row of rows) {
    const mine = row.is_from_me === 1;
    const counterparty = row.handle || row.chat || "unknown";
    const result = await ingestEvent({
      spaceId: opts.spaceId,
      sourceId,
      kind: "message",
      direction: mine ? "outbound" : "inbound",
      occurredAt: appleToDate(Number(row.date)),
      externalId: `imsg:${row.ROWID}`,
      threadId: `imsg:${row.chat || counterparty}`,
      body: String(row.text),
      metadata: { platform: "imessage", chat: row.chat, handle: row.handle },
      sensitivity: opts.sensitivity,
      participants: counterparty === "unknown" ? [] : [{
        kind: counterparty.includes("@") ? "email" : "phone",
        value: counterparty,
        role: mine ? "to" : "from",
      }],
    });
    if (result.created) created++;
  }

  return { seen: rows.length, created };
}
