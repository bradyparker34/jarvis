/**
 * Telegram, via Telegram Desktop's own JSON export.
 *
 * Settings, Advanced, Export Telegram data, JSON. Covers full history with no
 * API credentials and no rate limits. For continuous sync afterwards, the
 * MTProto API is legitimate and documented; this importer is what gets the
 * back history in, which is the part that actually carries context.
 */

import { readFile } from "node:fs/promises";
import { getOrCreateSource, ingestEvent, type Sensitivity } from "../lib/ingest.ts";

type TgMessage = {
  id: number;
  type?: string;
  date?: string;
  date_unixtime?: string;
  from?: string;
  from_id?: string;
  text?: unknown;
  action?: string;
};

/** Telegram writes text as a string, or an array mixing strings and entities. */
function flattenText(text: unknown): string {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) {
    return text.map((part) =>
      typeof part === "string" ? part : ((part as any)?.text ?? "")).join("");
  }
  return "";
}

export async function ingestTelegramExport(opts: {
  path: string;
  spaceId: string;
  me?: string;
  sensitivity?: Sensitivity;
  /** Only import these chat names; omit for everything. */
  chats?: string[];
}): Promise<{ seen: number; created: number; chats: number }> {
  const raw = JSON.parse(await readFile(opts.path, "utf8"));
  const chats: any[] = raw.chats?.list ?? (raw.messages ? [raw] : []);

  let seen = 0, created = 0, used = 0;

  for (const chat of chats) {
    const name = chat.name ?? chat.title ?? `chat-${chat.id}`;
    if (opts.chats?.length && !opts.chats.includes(name)) continue;
    used++;
    const sourceId = await getOrCreateSource(opts.spaceId, "telegram", String(name));

    for (const message of (chat.messages ?? []) as TgMessage[]) {
      if (message.type && message.type !== "message") continue;
      const body = flattenText(message.text).trim();
      if (!body) continue;
      seen++;

      const when = message.date_unixtime
        ? new Date(Number(message.date_unixtime) * 1000)
        : new Date(message.date ?? 0);
      const author = message.from ?? "unknown";
      const mine = opts.me && author.toLowerCase() === opts.me.toLowerCase();

      const result = await ingestEvent({
        spaceId: opts.spaceId,
        sourceId,
        kind: "message",
        direction: mine ? "outbound" : "inbound",
        occurredAt: when,
        externalId: `tg:${chat.id}:${message.id}`,
        threadId: `tg:${chat.id}`,
        body,
        metadata: { chat: name, author, platform: "telegram" },
        sensitivity: opts.sensitivity,
        participants: [{
          kind: "telegram",
          value: message.from_id ?? author,
          name: author,
          role: "from",
        }],
      });
      if (result.created) created++;
    }
  }
  return { seen, created, chats: used };
}
