/**
 * Gmail, live.
 *
 * mbox covers the back catalogue; this keeps up. The split matters: Takeout
 * gets ten years in one file with no OAuth app to maintain, and this adapter
 * only has to handle what has arrived since, which is a much smaller and more
 * forgiving problem.
 *
 * Two sync modes, and the fallback between them is the part that matters:
 *
 *   history  — incremental, from the historyId stored on the source. Cheap.
 *   window   — list by date range. Used for the first run, and whenever Gmail
 *              rejects the stored historyId as too old, which it does after
 *              roughly a week of inactivity. Without the fallback, a mailbox
 *              left alone over a holiday silently stops syncing and nothing
 *              says so.
 *
 * Mapping is kept as pure functions below the sync loop, because that is the
 * half that can be tested without a live mailbox, and it is also the half that
 * gets subtly wrong answers — a multipart/alternative with an empty text part,
 * an encoded-word subject, a reply whose quoted history is longer than the
 * message.
 */

import { googleGet } from "../lib/google.ts";
import {
  decodeBase64Url, decodeEncodedWords, htmlToText, parseAddresses, stripQuoted,
} from "../lib/email.ts";
import {
  getOrCreateSource, getCursor, setCursor, ingestEvent,
  type EventInput, type Participant,
} from "../lib/ingest.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

// ----------------------------------------------------------------- shapes

export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};

export type GmailMessage = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
};

// ------------------------------------------------------------ pure mapping

/** Header lookup is case-insensitive and Gmail is inconsistent about case. */
export function header(message: GmailMessage, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === wanted)?.value;
}

/**
 * Walk the MIME tree for the best readable body.
 *
 * Preference is text/plain, then text/html converted to text. Attachments are
 * skipped: a part with a filename is a file, not prose, and its bytes are not
 * in this response anyway.
 */
export function extractBody(part: GmailPart | undefined): string {
  if (!part) return "";

  const collect = (node: GmailPart, mime: string): string[] => {
    const out: string[] = [];
    if (node.filename) return out;                       // attachment, not prose
    if (node.mimeType === mime && node.body?.data) out.push(decodeBase64Url(node.body.data));
    for (const child of node.parts ?? []) out.push(...collect(child, mime));
    return out;
  };

  const plain = collect(part, "text/plain").join("\n").trim();
  if (plain) return plain;

  const html = collect(part, "text/html").join("\n").trim();
  if (html) return htmlToText(html);

  // Single-part message: the body hangs off the root with no child parts.
  if (part.body?.data) {
    const raw = decodeBase64Url(part.body.data);
    return part.mimeType === "text/html" ? htmlToText(raw) : raw;
  }
  return "";
}

/** Attachment filenames, kept as metadata so a search can find "the deck Leo sent". */
export function attachmentNames(part: GmailPart | undefined): string[] {
  if (!part) return [];
  const out: string[] = [];
  if (part.filename) out.push(part.filename);
  for (const child of part.parts ?? []) out.push(...attachmentNames(child));
  return out;
}

/**
 * One Gmail message into one event.
 *
 * `myAddresses` decides direction. Gmail's SENT label would be simpler but is
 * wrong for a mailbox that receives its own mail through a group or alias, and
 * direction drives whether a claim reads as "they said" or "I said".
 */
export function toEvent(
  message: GmailMessage,
  opts: { spaceId: string; sourceId: string; myAddresses?: string[] },
): EventInput {
  const mine = new Set((opts.myAddresses ?? []).map((a) => a.toLowerCase()));

  const from = parseAddresses(header(message, "from"), "from");
  const participants: Participant[] = [
    ...from,
    ...parseAddresses(header(message, "to"), "to"),
    ...parseAddresses(header(message, "cc"), "cc"),
  ];

  const labels = message.labelIds ?? [];
  const outbound = from.some((p) => mine.has(p.value.toLowerCase())) || labels.includes("SENT");

  // internalDate is Gmail's own receive time in epoch ms and is always present
  // and always sane. The Date header is supplied by the sender and is
  // routinely absent, malformed, or years wrong.
  const occurredAt = message.internalDate
    ? new Date(Number(message.internalDate))
    : new Date(header(message, "date") ?? 0);

  const subject = header(message, "subject");
  const attachments = attachmentNames(message.payload);
  const body = stripQuoted(extractBody(message.payload)) || (message.snippet ?? "");

  return {
    spaceId: opts.spaceId,
    sourceId: opts.sourceId,
    kind: "email",
    direction: outbound ? "outbound" : "inbound",
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date(0) : occurredAt,
    // Gmail's message id, not the RFC Message-ID header: stable, unique per
    // mailbox, and what the API will hand back on the next sync.
    externalId: message.id,
    threadId: message.threadId,
    subject: subject ? decodeEncodedWords(subject) : undefined,
    body: body.slice(0, 20_000),
    metadata: {
      platform: "gmail",
      labels,
      ...(attachments.length ? { attachments } : {}),
      ...(header(message, "list-id") ? { list: header(message, "list-id") } : {}),
    },
    participants,
  };
}

// --------------------------------------------------------------- sync loop

type ListPage = { messages?: { id: string }[]; nextPageToken?: string };
type HistoryPage = {
  history?: { messagesAdded?: { message: { id: string } }[] }[];
  nextPageToken?: string;
  historyId?: string;
};

async function fetchMessage(handle: string, id: string): Promise<GmailMessage> {
  return googleGet<GmailMessage>(handle, `${API}/messages/${id}?format=full`);
}

/** Message ids changed since a historyId. Throws NOT_FOUND when it has aged out. */
async function idsSinceHistory(handle: string, startHistoryId: string): Promise<string[]> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API}/history`);
    url.searchParams.set("startHistoryId", startHistoryId);
    url.searchParams.set("historyTypes", "messageAdded");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await googleGet<HistoryPage>(handle, url.toString());
    for (const entry of page.history ?? []) {
      for (const added of entry.messagesAdded ?? []) ids.add(added.message.id);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return [...ids];
}

/** Message ids in a date window, used for the first run and after a stale cursor. */
async function idsInWindow(handle: string, sinceDays: number, max: number): Promise<string[]> {
  const after = new Date(Date.now() - sinceDays * 86_400_000);
  const stamp = `${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${API}/messages`);
    url.searchParams.set("q", `after:${stamp}`);
    url.searchParams.set("maxResults", "500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await googleGet<ListPage>(handle, url.toString());
    for (const m of page.messages ?? []) {
      ids.push(m.id);
      if (ids.length >= max) return ids;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  return ids;
}

export type GmailSyncResult = {
  handle: string;
  space: string;
  mode: "history" | "window";
  seen: number;
  created: number;
  errors: number;
};

/**
 * Sync one mailbox into one space.
 *
 * One account maps to exactly one arena, always. That is the whole boundary:
 * if the Bitdeer mailbox could write into another space, no amount of query
 * filtering downstream would put the material back where it belongs.
 */
export async function syncGmail(opts: {
  handle: string;
  spaceId: string;
  myAddresses?: string[];
  /** Window size for a first run or a stale cursor. Default 30 days. */
  sinceDays?: number;
  /** Ceiling on one run, so a first sync cannot run unbounded. */
  max?: number;
  concurrency?: number;
}): Promise<GmailSyncResult> {
  const sourceId = await getOrCreateSource(opts.spaceId, "gmail", opts.handle);
  const cursor = await getCursor(sourceId) as { historyId?: string };
  const max = opts.max ?? 2000;

  let mode: GmailSyncResult["mode"] = "window";
  let ids: string[] = [];

  if (cursor.historyId) {
    try {
      ids = await idsSinceHistory(opts.handle, cursor.historyId);
      mode = "history";
    } catch (err) {
      if (!/NOT_FOUND/.test(String(err))) throw err;
      // Cursor aged out — Gmail keeps history for about a week. Fall back to a
      // window rather than stopping, because ingestion is idempotent on
      // (source_id, external_id) and re-seeing a message costs nothing.
      console.warn(`[jarvis] ${opts.handle}: history cursor expired, falling back to a ${opts.sinceDays ?? 30}-day window`);
      ids = await idsInWindow(opts.handle, opts.sinceDays ?? 30, max);
    }
  } else {
    ids = await idsInWindow(opts.handle, opts.sinceDays ?? 30, max);
  }

  if (ids.length > max) ids = ids.slice(0, max);

  let created = 0, errors = 0;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 8, 20));

  // Bounded concurrency: Gmail's per-user quota is generous but not infinite,
  // and a thousand parallel gets earns a 429 for the whole run.
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    const messages = await Promise.all(batch.map(async (id) => {
      try {
        return await fetchMessage(opts.handle, id);
      } catch (err) {
        errors++;
        console.warn(`[jarvis] ${opts.handle}: skipped ${id}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    }));

    for (const message of messages) {
      if (!message) continue;
      try {
        const result = await ingestEvent(
          toEvent(message, { spaceId: opts.spaceId, sourceId, myAddresses: opts.myAddresses }),
        );
        if (result.created) created++;
      } catch (err) {
        errors++;
        console.warn(`[jarvis] ${opts.handle}: failed to store ${message.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // The cursor advances to the mailbox's current historyId, read after the
  // run. Taken before, anything arriving mid-run would be skipped forever.
  const profile = await googleGet<{ historyId?: string }>(opts.handle, `${API}/profile`);
  if (profile.historyId) await setCursor(sourceId, { historyId: profile.historyId });

  return { handle: opts.handle, space: opts.spaceId, mode, seen: ids.length, created, errors };
}
