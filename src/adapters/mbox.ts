/**
 * Email from an mbox file: Google Takeout, Apple Mail, Thunderbird.
 *
 * Takeout gives you the entire history in one file with no OAuth app, no
 * verification screens and no token to leak. For ongoing sync afterwards the
 * Gmail API is the right tool; this is how the back catalogue gets in, and the
 * back catalogue is where the context lives.
 *
 * takeout.google.com, deselect all, choose Mail.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { getOrCreateSource, ingestEvent, type Sensitivity } from "../lib/ingest.ts";
import {
  decodeBody, decodeEncodedWords, parseAddresses, parseHeaderBlock, stripQuoted,
} from "../lib/email.ts";

export async function ingestMbox(opts: {
  path: string;
  spaceId: string;
  /** Your own addresses, so outbound mail is marked as yours. */
  myAddresses?: string[];
  sensitivity?: Sensitivity;
  label?: string;
}): Promise<{ seen: number; created: number }> {
  const sourceId = await getOrCreateSource(opts.spaceId, "mbox", opts.label ?? opts.path);
  const mine = new Set((opts.myAddresses ?? []).map((a) => a.toLowerCase()));

  let seen = 0, created = 0;
  let raw: string[] = [];

  const flush = async () => {
    if (!raw.length) return;
    const text = raw.join("\n");
    raw = [];

    const split = text.indexOf("\n\n");
    const headerBlock = split === -1 ? text : text.slice(0, split);
    const bodyBlock = split === -1 ? "" : text.slice(split + 2);

    const headers = parseHeaderBlock(headerBlock);
    if (!headers["from"] && !headers["subject"]) return;
    seen++;

    const from = parseAddresses(headers["from"], "from");
    const participants = [
      ...from,
      ...parseAddresses(headers["to"], "to"),
      ...parseAddresses(headers["cc"], "cc"),
    ];
    const outbound = from.some((p) => mine.has(p.value.toLowerCase()));
    const when = headers["date"] ? new Date(headers["date"]) : new Date(0);

    const result = await ingestEvent({
      spaceId: opts.spaceId,
      sourceId,
      kind: "email",
      direction: outbound ? "outbound" : "inbound",
      occurredAt: Number.isNaN(when.getTime()) ? new Date(0) : when,
      externalId: headers["message-id"] ?? `mbox:${headers["date"]}:${headers["subject"]}`,
      threadId: headers["in-reply-to"] ?? headers["references"]?.split(/\s+/)[0] ?? headers["message-id"],
      subject: headers["subject"] ? decodeEncodedWords(headers["subject"]) : undefined,
      body: stripQuoted(decodeBody(bodyBlock, headers)).slice(0, 20_000),
      metadata: { platform: "email", list: headers["list-id"] },
      sensitivity: opts.sensitivity,
      participants,
    });
    if (result.created) created++;
  };

  // Streamed: a Takeout mbox is routinely several gigabytes.
  const reader = createInterface({
    input: createReadStream(opts.path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    if (line.startsWith("From ") && raw.length) await flush();
    raw.push(line);
  }
  await flush();

  return { seen, created };
}
