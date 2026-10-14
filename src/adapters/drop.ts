/**
 * The drop folder: inbox/<space>/anything, dispatched by file type.
 *
 * This is the escape hatch that makes the system useful on day one, before a
 * single API is wired up. Export a chat, save a transcript, write a note, drop
 * it in the right folder, run `jarvis ingest`. Files move to inbox/<space>/done
 * so a repeat run does not reprocess them.
 */

import { readdir, mkdir, rename, readFile, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { getOrCreateSource, ingestEvent } from "../lib/ingest.ts";
import { ingestWhatsAppExport } from "./whatsapp.ts";
import { ingestTelegramExport } from "./telegram.ts";
import { ingestMbox } from "./mbox.ts";
import { repoRoot } from "../lib/db.ts";

export type DropReport = { file: string; space: string; seen: number; created: number; via: string };

async function ingestPlainText(path: string, spaceId: string): Promise<{ seen: number; created: number }> {
  const text = await readFile(path, "utf8");
  if (!text.trim()) return { seen: 0, created: 0 };
  const name = basename(path);
  const sourceId = await getOrCreateSource(spaceId, "files", "drop");
  const info = await stat(path);

  // A transcript is a meeting; anything else is a note. Crude, and right often
  // enough that it is not worth a classifier.
  const isTranscript = /transcript|meeting|call|notes?/i.test(name) || /\n\d{1,2}:\d{2}/.test(text);

  const result = await ingestEvent({
    spaceId,
    sourceId,
    kind: isTranscript ? "meeting" : "note",
    occurredAt: info.mtime,
    externalId: `drop:${name}:${info.size}`,
    subject: name.replace(extname(name), ""),
    body: text.slice(0, 100_000),
    metadata: { filename: name, bytes: info.size },
  });
  return { seen: 1, created: result.created ? 1 : 0 };
}

export async function ingestDropFolder(opts: {
  root?: string;
  me?: string;
  myAddresses?: string[];
}= {}): Promise<DropReport[]> {
  const root = opts.root ?? join(repoRoot, "inbox");
  const reports: DropReport[] = [];

  let spaces: string[];
  try {
    spaces = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    await mkdir(root, { recursive: true });
    return reports;
  }

  for (const space of spaces) {
    const dir = join(root, space);
    const done = join(dir, "done");
    await mkdir(done, { recursive: true });

    const files = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && !d.name.startsWith("."));

    for (const file of files) {
      const path = join(dir, file.name);
      const ext = extname(file.name).toLowerCase();
      let out = { seen: 0, created: 0 };
      let via = "note";

      try {
        if (/whatsapp/i.test(file.name) && ext === ".txt") {
          via = "whatsapp";
          out = await ingestWhatsAppExport({ path, spaceId: space, me: opts.me });
        } else if (ext === ".json" && /telegram|result/i.test(file.name)) {
          via = "telegram";
          const r = await ingestTelegramExport({ path, spaceId: space, me: opts.me });
          out = { seen: r.seen, created: r.created };
        } else if (ext === ".mbox" || ext === ".eml") {
          via = "mbox";
          out = await ingestMbox({ path, spaceId: space, myAddresses: opts.myAddresses });
        } else if ([".txt", ".md", ".vtt", ".srt", ".csv"].includes(ext)) {
          via = "text";
          out = await ingestPlainText(path, space);
        } else {
          continue;
        }
        await rename(path, join(done, file.name));
        reports.push({ file: file.name, space, via, ...out });
      } catch (err) {
        reports.push({
          file: `${file.name} — FAILED: ${err instanceof Error ? err.message : String(err)}`,
          space, via, seen: 0, created: 0,
        });
      }
    }
  }
  return reports;
}
