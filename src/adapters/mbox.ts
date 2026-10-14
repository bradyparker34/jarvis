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
import { getOrCreateSource, ingestEvent, type Participant, type Sensitivity } from "../lib/ingest.ts";

type Headers = Record<string, string>;

function decodeBody(body: string, headers: Headers): string {
  const encoding = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  try {
    if (encoding === "base64") return Buffer.from(body, "base64").toString("utf8");
    if (encoding === "quoted-printable") {
      return body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
  } catch { /* fall through to raw */ }
  return body;
}

/** "Tim <tim@x.com>, a@b.com" into participants. */
function parseAddresses(value: string | undefined, role: Participant["role"]): Participant[] {
  if (!value) return [];
  const out: Participant[] = [];
  for (const chunk of value.split(/,(?![^<]*>)/)) {
    const match = chunk.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/) ?? chunk.match(/^\s*(\S+@\S+)\s*$/);
    if (!match) continue;
    const email = (match[2] ?? match[1] ?? "").trim();
    if (!email.includes("@")) continue;
    const name = match[2] ? match[1]?.trim() : undefined;
    out.push({ kind: "email", value: email, name: name || undefined, role });
  }
  return out;
}

/**
 * Strips quoted history so each message carries only what was newly written.
 * Without this, one long thread embeds the same paragraphs twenty times and
 * dominates every search for the words in it.
 */
function stripQuoted(body: string): string {
  const lines = body.split(/\r?\n/);
  const cut = lines.findIndex((line) =>
    /^\s*On .+ wrote:\s*$/.test(line) ||
    /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line) ||
    /^\s*From:\s.+@/.test(line));
  return (cut > 0 ? lines.slice(0, cut) : lines).join("\n").trim();
}

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

    // Unfold continuation lines before parsing.
    const headers: Headers = {};
    for (const line of headerBlock.replace(/\n[ \t]+/g, " ").split("\n")) {
      const at = line.indexOf(":");
      if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
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
      subject: headers["subject"],
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
