/**
 * WhatsApp, via the export the app itself gives you.
 *
 * There is no legitimate API for a personal WhatsApp account. Every library
 * that claims otherwise drives the web client or a reverse-engineered socket,
 * which breaks WhatsApp's terms and gets numbers banned. Export is the only
 * route that is both allowed and durable.
 *
 * In WhatsApp: open a chat, menu, More, Export chat, Without media. Drop the
 * resulting .txt in inbox/<space>/ and run `jarvis ingest`.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { getOrCreateSource, ingestEvent, type Sensitivity } from "../lib/ingest.ts";

// "12/03/2026, 14:22 - Tim: message" and the US/bracketed variants.
const LINE = /^\[?(\d{1,2}[./]\d{1,2}[./]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*([AaPp][Mm])?\]?\s*[-–]?\s*([^:]{1,60}?):\s([\s\S]*)$/;

function parseWhen(date: string, time: string, meridiem?: string): Date | null {
  const parts = date.split(/[./]/).map(Number);
  if (parts.length !== 3) return null;
  let [a, b, y] = parts as [number, number, number];
  if (y < 100) y += 2000;
  // Day-first unless the first number cannot be a day.
  const [day, month] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b];
  const [hh, mm, ss = 0] = time.split(":").map(Number) as [number, number, number?];
  let hour = hh;
  if (meridiem) {
    const pm = meridiem.toLowerCase() === "pm";
    hour = hh % 12 + (pm ? 12 : 0);
  }
  const when = new Date(y, month - 1, day, hour, mm, ss);
  return Number.isNaN(when.getTime()) ? null : when;
}

export async function ingestWhatsAppExport(opts: {
  path: string;
  spaceId: string;
  /** Your own name exactly as it appears in the export, so direction is right. */
  me?: string;
  sensitivity?: Sensitivity;
}): Promise<{ seen: number; created: number }> {
  const text = await readFile(opts.path, "utf8");
  const chatName = basename(opts.path).replace(/^WhatsApp Chat with /i, "").replace(/\.txt$/i, "");
  const sourceId = await getOrCreateSource(opts.spaceId, "whatsapp_export", chatName);

  let seen = 0;
  let created = 0;
  let current: { when: Date; who: string; lines: string[] } | null = null;

  const flush = async () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    // System lines carry no signal and would pollute both search and the graph.
    if (!body || /^(messages and calls are end-to-end encrypted|<media omitted>|this message was deleted)/i.test(body)) {
      current = null;
      return;
    }
    seen++;
    const mine = opts.me && current.who.toLowerCase() === opts.me.toLowerCase();
    const result = await ingestEvent({
      spaceId: opts.spaceId,
      sourceId,
      kind: "message",
      direction: mine ? "outbound" : "inbound",
      occurredAt: current.when,
      // Stable across re-exports, so re-importing the same chat is a no-op.
      externalId: `wa:${chatName}:${current.when.toISOString()}:${current.who}:${body.slice(0, 40)}`,
      threadId: `wa:${chatName}`,
      body,
      metadata: { chat: chatName, author: current.who, platform: "whatsapp" },
      sensitivity: opts.sensitivity,
      participants: [{ kind: "whatsapp", value: current.who, name: current.who, role: mine ? "from" : "from" }],
    });
    if (result.created) created++;
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(LINE);
    if (match) {
      await flush();
      const when = parseWhen(match[1]!, match[2]!, match[3]);
      if (!when) continue;
      current = { when, who: match[4]!.trim(), lines: [match[5] ?? ""] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  await flush();
  return { seen, created };
}
