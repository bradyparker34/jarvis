/**
 * The one door everything comes through.
 *
 * Every adapter — Gmail, Telegram, a WhatsApp export, a meeting transcript, a
 * note you typed — normalises into the same shape and calls ingestEvent. That
 * keeps adapters thin and means identity resolution, deduplication and
 * sensitivity defaults are decided in exactly one place.
 *
 * Ingestion is idempotent on (source_id, external_id). Re-running an adapter
 * over a window you have already pulled is safe and cheap, which matters
 * because that is what resuming after a failure looks like.
 */

import { one, q } from "./db.ts";
import { resolveIdentity, type IdentifierKind } from "./identity.ts";

export type Sensitivity = "open" | "private" | "confidential" | "restricted";
export type EventKind =
  | "message" | "email" | "call" | "meeting" | "note"
  | "document" | "transaction" | "commitment" | "observation";

export type Participant = {
  kind: IdentifierKind;
  value: string;
  name?: string | undefined;
  role?: "from" | "to" | "cc" | "organiser" | "mentioned" | "participant";
};

export type EventInput = {
  spaceId: string;
  sourceId?: string | undefined;
  kind: EventKind;
  direction?: "inbound" | "outbound" | "internal" | undefined;
  occurredAt: Date | string;
  externalId?: string | undefined;
  threadId?: string | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  sensitivity?: Sensitivity | undefined;
  participants?: Participant[] | undefined;
};

export type IngestResult = { id: string; created: boolean };

/** Find or create the feed a batch of events belongs to. */
export async function getOrCreateSource(
  spaceId: string,
  kind: string,
  handle: string,
): Promise<string> {
  const existing = await one<{ id: string }>(
    `SELECT id FROM sources WHERE kind = $1 AND handle = $2 AND space_id = $3`,
    [kind, handle, spaceId],
  );
  if (existing) return existing.id;
  const row = await one<{ id: string }>(
    `INSERT INTO sources (space_id, kind, handle) VALUES ($1, $2, $3)
     ON CONFLICT (kind, handle, space_id) DO UPDATE SET enabled = sources.enabled
     RETURNING id`,
    [spaceId, kind, handle],
  );
  if (!row) throw new Error("failed to create source");
  return row.id;
}

export async function getCursor(sourceId: string): Promise<Record<string, unknown>> {
  const row = await one<{ cursor: Record<string, unknown> }>(
    `SELECT cursor FROM sources WHERE id = $1`, [sourceId],
  );
  return row?.cursor ?? {};
}

export async function setCursor(sourceId: string, cursor: Record<string, unknown>): Promise<void> {
  await q(
    `UPDATE sources SET cursor = $2, last_synced_at = now() WHERE id = $1`,
    [sourceId, JSON.stringify(cursor)],
  );
}

/** Space default, used when an adapter does not state a sensitivity. */
async function defaultSensitivity(spaceId: string): Promise<Sensitivity> {
  const row = await one<{ default_sensitivity: Sensitivity }>(
    `SELECT default_sensitivity FROM spaces WHERE id = $1`, [spaceId],
  );
  if (!row) throw new Error(`unknown space '${spaceId}' — run migrate to seed spaces`);
  return row.default_sensitivity;
}

export async function ingestEvent(input: EventInput): Promise<IngestResult> {
  const sensitivity = input.sensitivity ?? (await defaultSensitivity(input.spaceId));
  const occurred = input.occurredAt instanceof Date ? input.occurredAt : new Date(input.occurredAt);
  if (Number.isNaN(occurred.getTime())) {
    throw new Error(`invalid occurredAt: ${String(input.occurredAt)}`);
  }

  // ON CONFLICT needs a real update to return a row, so touch metadata. The
  // 'created' flag comes from xmax: zero means this insert created the row.
  const row = await one<{ id: string; created: boolean }>(
    `INSERT INTO events (space_id, source_id, kind, direction, occurred_at,
                         external_id, thread_id, subject, body, metadata, sensitivity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (source_id, external_id) DO UPDATE
       SET metadata = events.metadata || EXCLUDED.metadata
     RETURNING id, (xmax = 0) AS created`,
    [
      input.spaceId,
      input.sourceId ?? null,
      input.kind,
      input.direction ?? null,
      occurred.toISOString(),
      input.externalId ?? null,
      input.threadId ?? null,
      input.subject ?? null,
      input.body ?? null,
      JSON.stringify(input.metadata ?? {}),
      sensitivity,
    ],
  );
  if (!row) throw new Error("ingest produced no row");

  for (const participant of input.participants ?? []) {
    if (!participant.value) continue;
    try {
      const entityId = await resolveIdentity({
        kind: participant.kind,
        value: participant.value,
        name: participant.name,
      });
      await q(
        `INSERT INTO event_participants (event_id, entity_id, role)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [row.id, entityId, participant.role ?? "participant"],
      );
    } catch (err) {
      // One malformed address should not lose the whole message.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[jarvis] skipped participant ${participant.value}: ${message}`);
    }
  }

  return row;
}

/** Record a fact, with the event(s) that back it. */
export async function addClaim(input: {
  spaceId: string;
  subjectId?: string | undefined;
  predicate: string;
  objectText?: string | undefined;
  objectId?: string | undefined;
  objectNum?: number | undefined;
  objectTime?: Date | string | undefined;
  origin: "stated" | "extracted" | "derived" | "manual";
  confidence?: number | undefined;
  sensitivity?: Sensitivity | undefined;
  sourceEventIds?: string[] | undefined;
  quote?: string | undefined;
  /** Retire any live claim with the same subject and predicate. */
  supersede?: boolean | undefined;
}): Promise<string> {
  const sensitivity = input.sensitivity ?? (await defaultSensitivity(input.spaceId));

  const row = await one<{ id: string }>(
    `INSERT INTO claims (space_id, subject_id, predicate, object_text, object_id,
                         object_num, object_time, origin, confidence, sensitivity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      input.spaceId,
      input.subjectId ?? null,
      input.predicate,
      input.objectText ?? null,
      input.objectId ?? null,
      input.objectNum ?? null,
      input.objectTime ? new Date(input.objectTime).toISOString() : null,
      input.origin,
      input.confidence ?? 0.7,
      sensitivity,
    ],
  );
  if (!row) throw new Error("failed to create claim");

  if (input.supersede && input.subjectId) {
    await q(
      `UPDATE claims SET superseded_by = $1
        WHERE subject_id = $2 AND predicate = $3 AND space_id = $4
          AND id <> $1 AND superseded_by IS NULL`,
      [row.id, input.subjectId, input.predicate, input.spaceId],
    );
  }

  for (const eventId of input.sourceEventIds ?? []) {
    await q(
      `INSERT INTO claim_sources (claim_id, event_id, quote)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [row.id, eventId, input.quote ?? null],
    );
  }
  return row.id;
}

/**
 * Strengthen or create a relationship. Repeated contact raises the weight,
 * which is what makes the 3D map show your real network rather than every
 * person who ever cc'd you.
 */
export async function upsertEdge(input: {
  fromId: string;
  toId: string;
  kind: string;
  spaceId?: string | undefined;
  weightDelta?: number | undefined;
  confidence?: number | undefined;
  sourceEventId?: string | undefined;
}): Promise<void> {
  await q(
    `INSERT INTO edges (from_id, to_id, kind, space_id, weight, confidence, source_event_id, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (from_id, to_id, kind, space_id)
     DO UPDATE SET weight = edges.weight + EXCLUDED.weight,
                   confidence = GREATEST(edges.confidence, EXCLUDED.confidence),
                   ended_at = NULL`,
    [
      input.fromId, input.toId, input.kind, input.spaceId ?? null,
      input.weightDelta ?? 1, input.confidence ?? 0.7, input.sourceEventId ?? null,
    ],
  );
}

/**
 * Derive co-occurrence edges from who appears together on events. Cheap,
 * and it is what gives the map its shape before anyone curates a thing.
 */
export async function inferEdgesFromParticipation(spaceId?: string): Promise<number> {
  const rows = await q<{ n: number }>(
    `WITH pairs AS (
       SELECT a.entity_id AS from_id, b.entity_id AS to_id, e.space_id, count(*)::real AS n
       FROM event_participants a
       JOIN event_participants b ON a.event_id = b.event_id AND a.entity_id < b.entity_id
       JOIN events e ON e.id = a.event_id
       WHERE ($1::text IS NULL OR e.space_id = $1)
       GROUP BY 1,2,3
       HAVING count(*) >= 2
     )
     INSERT INTO edges (from_id, to_id, kind, space_id, weight, confidence, started_at)
     SELECT from_id, to_id, 'corresponds_with', space_id, n, 0.6, now() FROM pairs
     ON CONFLICT (from_id, to_id, kind, space_id)
     DO UPDATE SET weight = EXCLUDED.weight
     RETURNING 1 AS n`,
    [spaceId ?? null],
  );
  return rows.length;
}
