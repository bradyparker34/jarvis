/**
 * HTTP bridge for agents that cannot spawn a subprocess: n8n, a hosted agent,
 * a script, the 3D viewer.
 *
 * Bound to localhost and gated on a bearer token. The token is not decoration:
 * anything that reaches this port can read every message you own, so it does
 * not start without JARVIS_HTTP_TOKEN set.
 *
 *   GET  /health          liveness
 *   GET  /tools           tool catalogue
 *   POST /tools/:name     call a tool, body is the arguments object
 *   GET  /graph           nodes and edges for the viewer
 */

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tools, callTool, resolveScope, graphSnapshot } from "./tools.ts";
import { repoRoot } from "../lib/db.ts";

const port = Number(process.env.JARVIS_HTTP_PORT ?? 8787);
const token = process.env.JARVIS_HTTP_TOKEN;

if (!token) {
  console.error(
    "[jarvis] JARVIS_HTTP_TOKEN is not set. Generate one with `openssl rand -hex 32` and put it in .env.\n" +
    "        Refusing to serve your entire correspondence on an unauthenticated port.",
  );
  process.exit(1);
}

const expected = Buffer.from(`Bearer ${token}`);

/** Constant-time compare, so a wrong token leaks nothing by how fast it fails. */
const tokenMatches = (header: string): boolean => {
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const json = (res: any, code: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // Same-origin only: the viewer is served from this process.
    "access-control-allow-origin": "null",
  });
  res.end(payload);
};

const read = (req: any): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk;
      if (data.length > 2_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/health") return json(res, 200, { ok: true });

    // The viewer is served from here so it is same-origin with the API: no CORS
    // dance and no second server to run. It prompts for the token itself.
    if (url.pathname === "/" && req.method === "GET") {
      const html = await readFile(join(repoRoot, "viewer", "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    const auth = req.headers.authorization ?? "";
    if (!tokenMatches(auth)) return json(res, 401, { error: "unauthorized" });

    if (url.pathname === "/tools" && req.method === "GET") {
      return json(res, 200, tools.map(({ name, description, inputSchema }) => ({
        name, description, inputSchema,
      })));
    }

    if (url.pathname === "/graph" && req.method === "GET") {
      // This route resolved its own scope and treated "no spaces param" as
      // "every space", so the viewer's default view — and any agent calling
      // the bridge — rendered the Bitdeer graph. It now goes through the same
      // resolver as the tools: omitting spaces means everything shareable.
      const requested = url.searchParams.get("spaces")?.split(",").filter(Boolean);
      const scope = await resolveScope(
        requested?.length
          ? { spaces: requested, cross_space: url.searchParams.get("cross_space") === "true" }
          : {},
      );
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 400), 2000);
      return json(res, 200, await graphSnapshot(scope, limit));
    }

    const match = url.pathname.match(/^\/tools\/([a-z_]+)$/);
    if (match && req.method === "POST") {
      const body = await read(req);
      const args = body ? JSON.parse(body) : {};
      const caller = (req.headers["x-jarvis-caller"] as string) ?? "http";
      const result = await callTool(match[1]!, args, caller);
      return json(res, result.isError ? 400 : 200, result);
    }

    return json(res, 404, { error: "not found" });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[jarvis] http bridge on http://127.0.0.1:${port} (localhost only, token required)`);
});
