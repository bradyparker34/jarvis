/**
 * Email parsing shared by every mail source.
 *
 * mbox and Gmail arrive in completely different envelopes — one is raw RFC 822
 * off disk, the other is JSON from an API — but once the envelope is off, the
 * problems are identical: the same address formats, the same quoted history,
 * the same transfer encodings. Keeping that logic in one place means a fix to
 * quote-stripping improves the back catalogue and the live feed at once, which
 * is not true if each adapter carries its own copy.
 */

import type { Participant } from "./ingest.ts";

export type Headers = Record<string, string>;

/** Decode a body according to its Content-Transfer-Encoding header. */
export function decodeBody(body: string, headers: Headers): string {
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

/** Gmail's URL-safe base64, which differs from the standard alphabet. */
export function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * RFC 2047 encoded-word headers: "=?UTF-8?B?...?=". Subjects with an accent,
 * an em dash or a non-Latin script arrive this way, and left undecoded they
 * are unreadable and unsearchable.
 */
export function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (whole, charset: string, encoding: string, text: string) => {
      try {
        const bytes = encoding.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g,
              (_, hex) => String.fromCharCode(parseInt(hex, 16))), "binary");
        return new TextDecoder(charset.toLowerCase() as string).decode(bytes);
      } catch {
        return whole;
      }
    },
  );
}

/** `Tim <tim@x.com>, a@b.com` into participants. */
export function parseAddresses(
  value: string | undefined,
  role: Participant["role"],
): Participant[] {
  if (!value) return [];
  const out: Participant[] = [];
  // Split on commas that are not inside a <...> bracket.
  for (const chunk of decodeEncodedWords(value).split(/,(?![^<]*>)/)) {
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
 * Strip quoted history so each message carries only what was newly written.
 *
 * Without this, one long thread embeds the same paragraphs twenty times and
 * dominates every search for the words in it — and in a system that ranks by
 * relevance, a passage repeated twenty times outranks the one place it was
 * actually said.
 */
export function stripQuoted(body: string): string {
  const lines = body.split(/\r?\n/);
  const cut = lines.findIndex((line) =>
    /^\s*On .+ wrote:\s*$/.test(line) ||
    /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line) ||
    /^\s*_{5,}\s*$/.test(line) ||
    /^\s*From:\s.+@/.test(line));
  return (cut > 0 ? lines.slice(0, cut) : lines).join("\n").trim();
}

/**
 * Last-resort HTML to text, for mail with no text/plain part. Not a parser and
 * not trying to be: it exists so a marketing-template email is searchable
 * rather than a wall of markup.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    // Tags left padding around the breaks they produced; without this every
    // line arrives with a leading and trailing space.
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Unfold RFC 822 continuation lines and index headers lowercased. */
export function parseHeaderBlock(block: string): Headers {
  const headers: Headers = {};
  for (const line of block.replace(/\n[ \t]+/g, " ").split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return headers;
}
