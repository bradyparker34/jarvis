/**
 * The tool surface every agent sees. Shared by the stdio server (Claude
 * Desktop, Claude Code, Cursor) and the HTTP bridge (everything else), so
 * there is exactly one definition of what Jarvis can do.
 *
 * Two conventions run through all of it:
 *
 *   Provenance. Results carry ids and sources so an agent can cite why it
 *   believes something, and so you can audit the answer weeks later.
 *
 *   Space discipline. Omitting `spaces` searches everything shareable, which
 *   is all three businesses minus Bitdeer. Bitdeer only answers when named,
 *   because it is marked unshareable in the database.
 */

import { q, one, hasVectors } from "../lib/db.ts";
import { embedOne, toVector } from "../lib/embed.ts";
import { addClaim } from "../lib/ingest.ts";
import { resolveIdentity } from "../lib/identity.ts";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** Highest sensitivity a result may carry. 'restricted' is never readable. */
export type Ceiling = "private" | "confidential";

export type Scope = {
  /**
   * The spaces this call may read: validated, and already excluding
   * unshareable spaces unless the caller named one outright. Handlers filter
   * on this array and never look at the raw arguments again.
   */
  spaces: string[];
  ceiling: Ceiling;
  /** What the caller asked for, kept for the retrieval log. */
  requested: string[] | null;
  crossSpace: boolean;
};

/**
 * The one place scope is decided.
 *
 * Every handler and HTTP route that reads space-scoped rows goes through this
 * and filters on the array it returns. That is deliberate structure, not
 * tidiness: the Bitdeer leaks this replaced were all queries that resolved
 * scope themselves and got it wrong. who_is returned Bitdeer event bodies —
 * including rows marked 'restricted' — even when asked for scottsdale
 * outright, because its subquery had no space predicate at all. Handing
 * handlers a resolved list instead of raw arguments removes the chance to
 * forget.
 *
 * Unknown space ids raise out of resolve_scope() rather than resolving to an
 * empty set, so a typo reads as an error and not as "nothing known".
 */
export async function resolveScope(args: {
  spaces?: string[];
  cross_space?: boolean;
  include_confidential?: boolean;
}): Promise<Scope> {
  const requested = args.spaces?.length ? args.spaces : null;
  const crossSpace = requested ? args.cross_space === true : true;

  // Naming more than one space is deliberate arena-blending and now has to say
  // so. The parameter previously did nothing at all to a named list, so
  // spaces: ['bitdeer','lawrence'] quietly returned employer material and the
  // meat business fused into one result set — the exact mixing the space model
  // exists to prevent.
  //
  // Omitting spaces is unaffected: that sweep is shareable-only by
  // construction, so it can never pull an unshareable space in, and it is the
  // documented default every caller relies on.
  if (requested && requested.length > 1 && !crossSpace) {
    throw new Error(
      `reading ${requested.length} spaces at once (${requested.join(", ")}) requires cross_space: true. ` +
      `These are separate businesses; combining them in one result set should be on purpose. ` +
      `Omit spaces entirely to search everything shareable.`,
    );
  }

  const row = await one<{ spaces: string[] | null }>(
    `SELECT resolve_scope($1, $2) AS spaces`,
    [requested, crossSpace],
  );

  return {
    spaces: row?.spaces ?? [],
    ceiling: args.include_confidential === false ? "private" : "confidential",
    requested,
    crossSpace,
  };
}

async function logRetrieval(
  caller: string, query: string | null, scope: Scope, ids: string[], ms: number,
) {
  await q(
    `INSERT INTO retrievals (caller, query, spaces, cross_space, result_ids, result_count, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    // Log what was actually read, not what was asked for: when the two differ
    // the resolved set is the one that explains the answer.
    [caller, query, scope.spaces, scope.crossSpace, ids, ids.length, ms],
  ).catch(() => {});
}

export type Tool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  handler: (args: any, caller: string) => Promise<ToolResult>;
};

const spaceArg = {
  spaces: {
    type: "array", items: { type: "string" },
    description:
      "Which spaces to read: bitdeer, lawrence, scottsdale, personal. Omit to search everything shareable. Bitdeer is confidential and only answers when named here.",
  },
  cross_space: {
    type: "boolean",
    description: "Required when spaces names more than one space. These are separate businesses, so combining them in one result set has to be deliberate. Not needed for a single named space, or when spaces is omitted.",
  },
  include_confidential: {
    type: "boolean",
    description: "Include material marked confidential, such as employer correspondence. Default true; set false when drafting anything that leaves Brady's hands. Material marked restricted is never returned either way.",
  },
};

export const tools: Tool[] = [
  {
    name: "spaces",
    description:
      "List the arenas of life Jarvis tracks and how much is in each. Call this first if you are unsure which space a question belongs to.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const rows = await q(
        `SELECT s.id, s.label, s.description, s.default_sensitivity, s.shareable,
                (SELECT count(*) FROM events e WHERE e.space_id = s.id) AS events,
                (SELECT count(*) FROM claims c WHERE c.space_id = s.id AND c.superseded_by IS NULL) AS claims,
                (SELECT count(*) FROM decisions d WHERE d.space_id = s.id) AS decisions
         FROM spaces s ORDER BY s.id`,
      );
      return ok(rows);
    },
  },

  {
    name: "recall",
    description:
      "Search everything Brady has ever said, received or recorded. Hybrid keyword plus semantic search over messages, emails, meetings, notes, facts and entities. This is the default way to answer any 'what do we know about X' question.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are looking for, in natural language." },
        ...spaceArg,
        limit: { type: "number", description: "Max results, default 20." },
        since: { type: "string", description: "ISO date; only return things after this." },
      },
      required: ["query"],
    },
    handler: async (args, caller) => {
      const started = Date.now();
      const scope = await resolveScope(args);
      const vector = (await hasVectors()) ? await embedOne(args.query) : null;

      // The resolved list is passed as the space argument, so readable_spaces()
      // inside these functions returns it verbatim. Scope is decided once.
      const rows = await q(
        `SELECT * FROM recall($1, $2::vector, $3, false, $4, $5, $6)`,
        [
          args.query,
          vector ? toVector(vector) : null,
          scope.spaces, args.limit ?? 20, scope.ceiling,
          args.since ?? null,
        ],
      ).catch(async (err) => {
        // No pgvector: fall back to keyword search so the agent still gets an answer.
        if (!/function recall|does not exist|type "vector"/i.test(String(err))) throw err;
        return q(`SELECT 'event' AS object_type, id AS object_id, space_id, occurred_at,
                         subject AS title, left(coalesce(body,''), 400) AS snippet, score
                  FROM search_events($1, $2, false, $3, $4)`,
          [args.query, scope.spaces, args.limit ?? 20, scope.ceiling]);
      });

      await logRetrieval(caller, args.query, scope,
        rows.map((r: any) => r.object_id), Date.now() - started);

      if (!rows.length) {
        return ok(`Nothing found for "${args.query}". If this should exist, the relevant feed may not be connected yet — check \`jarvis doctor\`.`);
      }
      return ok(rows);
    },
  },

  {
    name: "who_is",
    description:
      "Everything known about one person or company: what they prefer, what they owe, who they connect to, and the last things they said. Call this before writing to someone or deciding anything involving them.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name, email address, phone number or handle." },
        ...spaceArg,
      },
      required: ["name"],
    },
    handler: async (args, caller) => {
      const started = Date.now();
      const scope = await resolveScope(args);
      const needle = String(args.name).trim();

      const entity = await one<{ id: string; name: string; kind: string; summary: string | null; aliases: string[] }>(
        `SELECT e.id, e.name, e.kind::text, e.summary, e.aliases
         FROM entities e
         LEFT JOIN identifiers i ON i.entity_id = e.id
         WHERE lower(e.name) = lower($1)
            OR e.aliases @> ARRAY[$1]
            OR lower(i.value) = lower($1)
         ORDER BY (lower(e.name) = lower($1)) DESC
         LIMIT 1`,
        [needle],
      );
      if (!entity) {
        // Only suggest people the caller could actually read about, or the
        // "close names" list becomes a directory of the spaces it cannot see.
        const near = await q(
          `SELECT DISTINCT e.name FROM entities e
             JOIN entity_spaces es ON es.entity_id = e.id
            WHERE e.search_tsv @@ plainto_tsquery('english', $1)
              AND es.space_id = ANY($2)
            LIMIT 5`,
          [needle, scope.spaces],
        );
        return ok(near.length
          ? `No exact match for "${needle}". Close names: ${near.map((n: any) => n.name).join(", ")}`
          : `No one called "${needle}" in Jarvis yet.`);
      }

      const [facts, links, recent, spacesIn] = await Promise.all([
        q(`SELECT * FROM entity_dossier($1, $2, false, $3)`,
          [entity.id, scope.spaces, scope.ceiling]),
        q(`SELECT * FROM graph_neighbors($1, 1, $2, false, 25)`, [entity.id, scope.spaces]),
        // This is where Bitdeer leaked: no space predicate and no sensitivity
        // ceiling, so every caller got the last ten events involving this
        // person from every space, confidential and restricted included.
        q(`SELECT e.id, e.space_id, e.kind::text, e.occurred_at, e.subject,
                  left(coalesce(e.body,''), 300) AS snippet
           FROM events e
           JOIN event_participants p ON p.event_id = e.id
           WHERE p.entity_id = $1
             AND e.space_id = ANY($2)
             AND e.sensitivity <= $3::sensitivity
           ORDER BY e.occurred_at DESC LIMIT 10`, [entity.id, scope.spaces, scope.ceiling]),
        // Participation counts and last-seen dates are themselves disclosure:
        // "appears in bitdeer, 412 events, last week" says plenty on its own.
        q(`SELECT space_id, role, event_count, last_seen_at
           FROM entity_spaces
           WHERE entity_id = $1 AND space_id = ANY($2)
           ORDER BY event_count DESC`, [entity.id, scope.spaces]),
      ]);

      // Entities are global by design, so a lookup can resolve someone this
      // caller may know nothing about. Confirming they exist is a small leak of
      // its own, so when nothing readable comes back, answer as if unknown.
      if (!facts.length && !recent.length && !spacesIn.length && !links.length) {
        await logRetrieval(caller, `who_is:${needle}`, scope, [], Date.now() - started);
        return ok(`Nothing readable about "${needle}" in ${scope.spaces.join(", ") || "any space"}. If this should exist, the relevant space may need naming explicitly.`);
      }

      await logRetrieval(caller, `who_is:${needle}`, scope, [entity.id], Date.now() - started);
      return ok({ entity, appears_in: spacesIn, facts, relationships: links, recent_events: recent });
    },
  },

  {
    name: "timeline",
    description:
      "What happened over a window, in order. Use for 'catch me up on X' or to reconstruct how a deal unfolded.",
    inputSchema: {
      type: "object",
      properties: {
        ...spaceArg,
        entity: { type: "string", description: "Optional: limit to one person or company." },
        since: { type: "string", description: "ISO date, default 30 days ago." },
        until: { type: "string", description: "ISO date, default now." },
        limit: { type: "number", description: "Default 50." },
      },
    },
    handler: async (args, caller) => {
      const started = Date.now();
      const scope = await resolveScope(args);
      const rows = await q(
        `WITH target AS (
                SELECT e.id FROM entities e
                LEFT JOIN identifiers i ON i.entity_id = e.id
                WHERE $2::text IS NOT NULL
                  AND (lower(e.name) = lower($2) OR e.aliases @> ARRAY[$2] OR lower(i.value) = lower($2))
                LIMIT 1
              )
         SELECT ev.id, ev.space_id, ev.kind::text, ev.direction::text, ev.occurred_at,
                ev.subject, left(coalesce(ev.body,''), 300) AS snippet,
                (SELECT array_agg(en.name) FROM event_participants p
                 JOIN entities en ON en.id = p.entity_id WHERE p.event_id = ev.id) AS people
         FROM events ev
         WHERE ev.space_id = ANY($1)
           AND ev.sensitivity <= $6::sensitivity
           AND ev.occurred_at >= coalesce($3::timestamptz, now() - interval '30 days')
           AND ev.occurred_at <= coalesce($4::timestamptz, now())
           AND (NOT EXISTS (SELECT 1 FROM target)
                OR EXISTS (SELECT 1 FROM event_participants p
                           WHERE p.event_id = ev.id AND p.entity_id = (SELECT id FROM target)))
         ORDER BY ev.occurred_at DESC
         LIMIT $5`,
        [
          scope.spaces, args.entity ?? null, args.since ?? null,
          args.until ?? null, args.limit ?? 50, scope.ceiling,
        ],
      );
      await logRetrieval(caller, "timeline", scope, rows.map((r: any) => r.id), Date.now() - started);
      return ok(rows);
    },
  },

  {
    name: "graph",
    description:
      "Walk the relationship graph outward from a person or company. Answers 'who connects me to them' and 'who else is in this orbit'.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Starting person or company." },
        depth: { type: "number", description: "Hops outward, 1-3. Default 2." },
        ...spaceArg,
      },
      required: ["name"],
    },
    handler: async (args, caller) => {
      const started = Date.now();
      const scope = await resolveScope(args);
      const entity = await one<{ id: string }>(
        `SELECT e.id FROM entities e LEFT JOIN identifiers i ON i.entity_id = e.id
         WHERE lower(e.name) = lower($1) OR e.aliases @> ARRAY[$1] OR lower(i.value) = lower($1) LIMIT 1`,
        [args.name],
      );
      if (!entity) return fail(`No one called "${args.name}" in Jarvis.`);
      const depth = Math.min(Math.max(Number(args.depth ?? 2), 1), 3);
      const rows = await q(`SELECT * FROM graph_neighbors($1,$2,$3,false,200)`,
        [entity.id, depth, scope.spaces]);
      // graph was the one read tool that logged nothing. The retrieval log is
      // how "why did it say that" gets answered six weeks later.
      await logRetrieval(caller, `graph:${args.name}`, scope,
        rows.map((r: any) => r.to_id), Date.now() - started);
      return ok(rows);
    },
  },

  {
    name: "remember",
    description:
      "Write a durable fact into the graph, with the reasoning behind it. Use when Brady states a preference, a term, a deadline or a conclusion that should shape later decisions. Do not use for passing chatter.",
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string", description: "bitdeer, lawrence, scottsdale or personal." },
        about: { type: "string", description: "Who or what this is about. Created if unknown." },
        fact: { type: "string", description: "The fact itself, in one line." },
        predicate: { type: "string", description: "Short relation key, e.g. prefers, owes, deadline, price_target. Default 'note'." },
        confidence: { type: "number", description: "0 to 1. Default 0.9 for something Brady said outright." },
        supersede: { type: "boolean", description: "Retire the previous value of this predicate for this subject. Use when a fact has changed." },
      },
      required: ["space", "fact"],
    },
    handler: async (args) => {
      let subjectId: string | undefined;
      if (args.about) {
        const found = await one<{ id: string }>(
          `SELECT e.id FROM entities e LEFT JOIN identifiers i ON i.entity_id = e.id
           WHERE lower(e.name) = lower($1) OR e.aliases @> ARRAY[$1] OR lower(i.value) = lower($1) LIMIT 1`,
          [args.about],
        );
        subjectId = found?.id ?? (await resolveIdentity({
          kind: String(args.about).includes("@") ? "email" : "handle",
          value: args.about, name: args.about,
        }));
      }
      const id = await addClaim({
        spaceId: args.space,
        subjectId,
        predicate: args.predicate ?? "note",
        objectText: args.fact,
        origin: "stated",
        confidence: args.confidence ?? 0.9,
        supersede: Boolean(args.supersede),
      });
      return ok({ claim_id: id, stored: args.fact, about: args.about ?? null, space: args.space });
    },
  },

  {
    name: "log_decision",
    description:
      "Record a decision, the context behind it and what is expected to happen. The prediction is what makes it gradeable later, so always include one. Use for any real call: a buy, a price, a hire, a deal structure.",
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string" },
        title: { type: "string", description: "Short name, e.g. 'Buy 126610LN at 9000'." },
        question: { type: "string", description: "The call being made, in one line." },
        chosen: { type: "string", description: "What was decided: BUY, PASS, the price agreed." },
        rationale: { type: "string", description: "Why. Be specific about the deciding factor." },
        prediction_metric: { type: "string", description: "What to measure, e.g. days_to_sell, margin_usd." },
        prediction_value: { type: "number", description: "The expected number." },
        prediction_by: { type: "string", description: "ISO date by which it should be known." },
        confidence: { type: "number", description: "0 to 1. Honest, not flattering: this feeds the calibration report." },
        stakes_usd: { type: "number", description: "Capital at risk." },
        reversible: { type: "boolean" },
        decided_by: { type: "string", description: "'brady' or 'agent:<name>'." },
        input_ids: {
          type: "array", items: { type: "string" },
          description: "Event or claim ids that informed this, from recall results. Strongly recommended: it is how you later tell a good call from a lucky one.",
        },
      },
      required: ["space", "title", "question", "chosen"],
    },
    handler: async (args, caller) => {
      const prediction = args.prediction_metric
        ? { metric: args.prediction_metric, value: args.prediction_value ?? null, by: args.prediction_by ?? null }
        : null;

      const row = await one<{ id: string }>(
        `INSERT INTO decisions (space_id, title, question, chosen, rationale, status,
                                decided_by, decided_at, prediction, confidence, stakes_usd, reversible)
         VALUES ($1,$2,$3,$4,$5,'decided',$6, now(), $7, $8, $9, $10) RETURNING id`,
        [
          args.space, args.title, args.question, args.chosen, args.rationale ?? null,
          args.decided_by ?? caller, prediction ? JSON.stringify(prediction) : null,
          args.confidence ?? null, args.stakes_usd ?? null, args.reversible ?? true,
        ],
      );
      if (!row) return fail("could not record decision");

      for (const id of (args.input_ids ?? []) as string[]) {
        const kind = await one<{ t: string }>(
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM events WHERE id = $1) THEN 'event'
                       WHEN EXISTS (SELECT 1 FROM claims WHERE id = $1) THEN 'claim'
                       ELSE 'entity' END AS t`, [id],
        ).catch(() => undefined);
        if (!kind) continue;
        await q(
          `INSERT INTO decision_inputs (decision_id, object_type, object_id)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [row.id, kind.t, id],
        ).catch(() => {});
      }

      return ok({
        decision_id: row.id,
        note: prediction
          ? "Logged with a prediction; it will appear in open_loops once due and ungraded."
          : "Logged WITHOUT a prediction, so this one can never be scored. Add one if the outcome is measurable.",
      });
    },
  },

  {
    name: "record_outcome",
    description:
      "Say what actually happened for a logged decision. Grades it against the prediction automatically. This is what turns history into judgement.",
    inputSchema: {
      type: "object",
      properties: {
        decision_id: { type: "string" },
        metric: { type: "string", description: "Must match what was predicted, e.g. days_to_sell." },
        actual: { type: "number" },
        notes: { type: "string" },
        lower_is_better: {
          type: "boolean",
          description: "True for days to sell, cost, time to close. False for margin or revenue.",
        },
      },
      required: ["decision_id", "metric", "actual"],
    },
    handler: async (args, caller) => {
      const row = await one(
        `SELECT * FROM record_outcome($1,$2,$3,$4,$5,0.10,$6)`,
        [args.decision_id, args.metric, args.actual, args.notes ?? null, caller, args.lower_is_better ?? false],
      );
      return ok(row ?? "no outcome recorded");
    },
  },

  {
    name: "review",
    description:
      "How decisions have actually turned out: hit rate by space, whether stated confidence matches reality, and which decisions are overdue for a verdict. Use for a weekly or quarterly honest look, or before making a similar call again.",
    inputSchema: {
      type: "object",
      properties: {
        space: {
          type: "string",
          description: "Optional: limit to one space. Omit to review everything shareable; name bitdeer to include it.",
        },
      },
    },
    handler: async (args, caller) => {
      const started = Date.now();
      // Unscoped review used to read every space, so Bitdeer decision titles,
      // chosen terms and stakes came back to any caller that asked for none.
      const scope = await resolveScope(args.space ? { spaces: [String(args.space)] } : {});

      const [scorecard, calib, loops, recent] = await Promise.all([
        q(`SELECT * FROM decision_scorecard WHERE space_id = ANY($1)`, [scope.spaces]),
        q(`SELECT * FROM calibration WHERE space_id = ANY($1)`, [scope.spaces]),
        q(`SELECT * FROM open_loops WHERE space_id = ANY($1) LIMIT 20`, [scope.spaces]),
        q(`SELECT d.id, d.space_id, d.title, d.chosen, d.confidence, d.stakes_usd,
                  o.metric, o.predicted_value, o.actual_value, o.verdict::text
           FROM decisions d JOIN outcomes o ON o.decision_id = d.id
           WHERE d.space_id = ANY($1)
           ORDER BY o.observed_at DESC LIMIT 15`, [scope.spaces]),
      ]);

      await logRetrieval(caller, "review", scope, recent.map((r: any) => r.id), Date.now() - started);
      return ok({
        reviewed_spaces: scope.spaces,
        scorecard,
        calibration: calib,
        overdue_for_a_verdict: loops,
        recently_graded: recent,
        how_to_read:
          "calibration compares stated confidence against how often the call landed. A 90% bucket hitting well under 90% means confidence is inflated, and any agent trusting it is inheriting that error.",
      });
    },
  },
];

/**
 * Nodes and edges for the viewer.
 *
 * This lives here rather than inline in the HTTP route for the same reason the
 * resolver does: the route's own copy of this query was the fourth leak, and a
 * query that sits next to the chokepoint and takes a resolved Scope cannot
 * quietly grow its own scope rules again. It is also testable without booting
 * a server, which is how it gets checked from now on.
 */
export async function graphSnapshot(scope: Scope, limit = 400) {
  const [nodes, edges] = await Promise.all([
    q(`SELECT e.id, e.name, e.kind::text,
              coalesce(sum(es.event_count), 0)::int AS weight,
              (array_agg(es.space_id ORDER BY es.event_count DESC))[1] AS space_id
       FROM entities e
       JOIN entity_spaces es ON es.entity_id = e.id
       WHERE es.space_id = ANY($1)
       GROUP BY e.id
       ORDER BY weight DESC
       LIMIT $2`, [scope.spaces, limit]),
    q(`SELECT from_id, to_id, kind, space_id, weight FROM edges
       WHERE ended_at IS NULL
         AND (space_id IS NULL OR space_id = ANY($1))
       ORDER BY weight DESC LIMIT $2`, [scope.spaces, limit * 3]),
  ]);
  const ids = new Set(nodes.map((n: any) => n.id));
  return {
    spaces: scope.spaces,
    nodes,
    edges: edges.filter((e: any) => ids.has(e.from_id) && ids.has(e.to_id)),
  };
}

export const toolMap = new Map(tools.map((t) => [t.name, t]));

export async function callTool(name: string, args: unknown, caller: string): Promise<ToolResult> {
  const tool = toolMap.get(name);
  if (!tool) return fail(`unknown tool: ${name}`);
  try {
    return await tool.handler(args ?? {}, caller);
  } catch (err) {
    return fail(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
