/**
 * Google OAuth for installed apps, over plain fetch.
 *
 * No SDK on purpose. `googleapis` is a very large dependency tree for what is,
 * in the end, three HTTP calls — a consent URL, a code exchange and a refresh
 * — and this database holds employer correspondence, so every package with
 * install scripts and transitive dependencies is surface that has to be worth
 * its keep. These three calls are not.
 *
 * Tokens live per account under .secrets/, which is gitignored, never in the
 * database. A refresh token is a standing grant to read a mailbox; it does not
 * belong in the same store as the mail, where a backup or a stray query can
 * carry it somewhere a password never would.
 */

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "./db.ts";

/** Read-only throughout. Jarvis ingests mail; it has no business sending it. */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

type ClientSecrets = {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
};

export type StoredToken = {
  handle: string;
  refresh_token: string;
  access_token?: string;
  /** Epoch ms. */
  expires_at?: number;
  scopes: string[];
};

const secretsDir = join(repoRoot, ".secrets");

function tokenPath(handle: string): string {
  // One file per mailbox: accounts are authorised separately and revoked
  // separately, and a single shared token file makes both impossible.
  return join(secretsDir, `google-${handle.replace(/[^a-z0-9.@_-]/gi, "_")}.json`);
}

export async function loadClientSecrets(path?: string): Promise<{ id: string; secret: string }> {
  const file = path ?? process.env.GOOGLE_CREDENTIALS_PATH;
  if (!file) {
    throw new Error(
      "GOOGLE_CREDENTIALS_PATH is not set. Create an OAuth client (Desktop app) at " +
      "console.cloud.google.com, download the JSON, and point GOOGLE_CREDENTIALS_PATH at it.",
    );
  }
  const parsed = JSON.parse(await readFile(file, "utf8")) as ClientSecrets;
  const creds = parsed.installed ?? parsed.web;
  if (!creds?.client_id || !creds.client_secret) {
    throw new Error(`${file} is not an OAuth client JSON (expected an "installed" or "web" key).`);
  }
  return { id: creds.client_id, secret: creds.client_secret };
}

export async function readToken(handle: string): Promise<StoredToken | undefined> {
  try {
    return JSON.parse(await readFile(tokenPath(handle), "utf8")) as StoredToken;
  } catch {
    return undefined;
  }
}

export async function writeToken(token: StoredToken): Promise<void> {
  await mkdir(secretsDir, { recursive: true });
  // 0600: this file is equivalent to a password for that mailbox.
  await writeFile(tokenPath(token.handle), JSON.stringify(token, null, 2), { mode: 0o600 });
}

/**
 * Run the consent flow for one mailbox and store its refresh token.
 *
 * Loopback redirect rather than the out-of-band flow, which Google retired. The
 * listener binds to 127.0.0.1 on an ephemeral port and serves exactly one
 * request.
 */
export async function authorize(opts: {
  handle: string;
  credentialsPath?: string;
  scopes?: string[];
  /** Called with the URL to open. Defaults to printing it. */
  onUrl?: (url: string) => void;
}): Promise<StoredToken> {
  const client = await loadClientSecrets(opts.credentialsPath);
  const scopes = opts.scopes ?? GMAIL_SCOPES;

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
    (resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<html><body style="font:16px system-ui;padding:3rem">${
            code
              ? "Authorised. You can close this tab and return to the terminal."
              : `Authorisation failed: ${error ?? "no code returned"}`
          }</body></html>`,
        );
        server.close();
        if (code) resolve({ code, redirectUri: `http://127.0.0.1:${port}` });
        else reject(new Error(`authorisation failed: ${error ?? "no code returned"}`));
      });

      server.on("error", reject);
      let port = 0;
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        consent.searchParams.set("client_id", client.id);
        consent.searchParams.set("redirect_uri", `http://127.0.0.1:${port}`);
        consent.searchParams.set("response_type", "code");
        consent.searchParams.set("scope", scopes.join(" "));
        // offline + consent is what actually returns a refresh token; without
        // both, a re-authorisation silently yields an access token only and
        // sync breaks an hour later.
        consent.searchParams.set("access_type", "offline");
        consent.searchParams.set("prompt", "consent");
        const url = consent.toString();
        (opts.onUrl ?? ((u) => console.log(`\nOpen this to authorise ${opts.handle}:\n\n${u}\n`)))(url);
      });

      setTimeout(() => {
        server.close();
        reject(new Error("timed out waiting for authorisation (5 minutes)"));
      }, 5 * 60_000).unref();
    },
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.id,
      client_secret: client.secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as {
    access_token: string; refresh_token?: string; expires_in: number;
  };
  if (!body.refresh_token) {
    throw new Error(
      "Google returned no refresh token. Revoke this app's access at " +
      "myaccount.google.com/permissions and authorise again.",
    );
  }

  const token: StoredToken = {
    handle: opts.handle,
    refresh_token: body.refresh_token,
    access_token: body.access_token,
    expires_at: Date.now() + body.expires_in * 1000,
    scopes,
  };
  await writeToken(token);
  return token;
}

/** A valid access token for this mailbox, refreshing when it has expired. */
export async function accessToken(handle: string, credentialsPath?: string): Promise<string> {
  const stored = await readToken(handle);
  if (!stored) {
    throw new Error(`${handle} is not connected. Run: jarvis connect --google --handle ${handle} --space <space>`);
  }
  // A minute of slack, so a token does not expire mid-page.
  if (stored.access_token && stored.expires_at && stored.expires_at - 60_000 > Date.now()) {
    return stored.access_token;
  }

  const client = await loadClientSecrets(credentialsPath);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: stored.refresh_token,
      client_id: client.id,
      client_secret: client.secret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (/invalid_grant/.test(text)) {
      throw new Error(
        `${handle}'s authorisation was revoked or expired. Re-run: jarvis connect --google --handle ${handle} --space <space>`,
      );
    }
    throw new Error(`token refresh failed for ${handle}: ${res.status} ${text}`);
  }
  const body = await res.json() as { access_token: string; expires_in: number };

  await writeToken({
    ...stored,
    access_token: body.access_token,
    expires_at: Date.now() + body.expires_in * 1000,
  });
  return body.access_token;
}

/**
 * Authorised GET against a Google API, with retry on the two failures that are
 * routine at volume: rate limiting and transient 5xx. Gmail will rate-limit a
 * backfill of a decade of mail no matter how politely it is paced, so handling
 * it is not optional.
 */
export async function googleGet<T>(
  handle: string, url: string, opts: { attempts?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  let lastError = "";

  for (let attempt = 0; attempt < attempts; attempt++) {
    const token = await accessToken(handle);
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.ok) return await res.json() as T;

    lastError = `${res.status} ${await res.text()}`;
    // 404 on a history cursor is meaningful to the caller, not a failure to
    // retry: it means the cursor aged out and a window backfill is needed.
    if (res.status === 404) throw new Error(`NOT_FOUND ${lastError}`);
    if (res.status !== 429 && res.status < 500) throw new Error(lastError);

    await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 32_000)));
  }
  throw new Error(`gave up after ${attempts} attempts: ${lastError}`);
}

/** Which mailbox a token actually belongs to, to catch authorising the wrong account. */
export async function whoami(handle: string): Promise<string | undefined> {
  const profile = await googleGet<{ emailAddress?: string }>(
    handle, "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  ).catch(() => undefined);
  return profile?.emailAddress;
}
