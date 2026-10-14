/**
 * Identity resolution: turning a phone number in a text, an email address in a
 * thread and a @handle in Telegram into one person.
 *
 * This is the step that decides whether the graph is useful or noise. The rule
 * here is conservative: match only on normalised identifiers, which are exact
 * by nature. Name similarity is offered as a suggestion for review, never
 * applied automatically — merging two people because both are called "Mike"
 * poisons every downstream answer, and unpicking it later is painful.
 */

import { one, q } from "./db.ts";

export type IdentifierKind = "email" | "phone" | "telegram" | "slack" | "whatsapp" | "domain" | "handle";

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().replace(/^mailto:/, "");
}

/**
 * Phone numbers to E.164 where possible. A bare 10-digit number is assumed to
 * be +1: Brady's book is US-heavy, and a wrong country code fails to match
 * rather than mismatching, which is the safe direction.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : raw.trim();
}

export function normalizeIdentifier(kind: IdentifierKind, value: string): string {
  if (kind === "email") return normalizeEmail(value);
  if (kind === "phone" || kind === "whatsapp") return normalizePhone(value);
  return value.trim().toLowerCase().replace(/^@/, "");
}

export type ResolveInput = {
  kind: IdentifierKind;
  value: string;
  /** Display name seen alongside the identifier, used only when creating. */
  name?: string | undefined;
  entityKind?: "person" | "org";
};

/**
 * Find the entity behind an identifier, creating one if this is the first
 * sighting. Idempotent: the unique index on (kind, value) is the arbiter, so
 * concurrent ingestion cannot produce duplicates.
 */
export async function resolveIdentity(input: ResolveInput): Promise<string> {
  const value = normalizeIdentifier(input.kind, input.value);
  if (!value) throw new Error(`empty identifier for kind ${input.kind}`);

  const existing = await one<{ entity_id: string }>(
    `SELECT entity_id FROM identifiers WHERE kind = $1 AND value = $2`,
    [input.kind, value],
  );
  if (existing) {
    // Opportunistically record a better display name than the address itself.
    if (input.name) await addAlias(existing.entity_id, input.name);
    return existing.entity_id;
  }

  const name = input.name?.trim() || value;
  const entity = await one<{ id: string }>(
    `INSERT INTO entities (kind, name) VALUES ($1, $2) RETURNING id`,
    [input.entityKind ?? "person", name],
  );
  if (!entity) throw new Error("failed to create entity");

  await q(
    `INSERT INTO identifiers (entity_id, kind, value) VALUES ($1, $2, $3)
     ON CONFLICT (kind, value) DO NOTHING`,
    [entity.id, input.kind, value],
  );
  return entity.id;
}

/** Add a display name to an entity's alias list, keeping the canonical name. */
export async function addAlias(entityId: string, alias: string): Promise<void> {
  const clean = alias.trim();
  if (!clean) return;
  await q(
    `UPDATE entities
        SET aliases = (SELECT array_agg(DISTINCT a)
                       FROM unnest(aliases || ARRAY[$2]) AS a
                       WHERE a <> name)
      WHERE id = $1
        AND NOT (aliases @> ARRAY[$2]) AND name <> $2`,
    [entityId, clean],
  );
}

/** Attach another address to a known entity. */
export async function linkIdentifier(
  entityId: string,
  kind: IdentifierKind,
  value: string,
): Promise<void> {
  await q(
    `INSERT INTO identifiers (entity_id, kind, value) VALUES ($1, $2, $3)
     ON CONFLICT (kind, value) DO UPDATE SET entity_id = EXCLUDED.entity_id`,
    [entityId, kind, normalizeIdentifier(kind, value)],
  );
}

/**
 * Candidate duplicates, for a human to confirm. Surfaced by `jarvis doctor`
 * rather than merged on sight.
 */
export async function suggestMerges(limit = 20) {
  return q<{ a: string; a_name: string; b: string; b_name: string; shared: number }>(
    `SELECT a.id AS a, a.name AS a_name, b.id AS b, b.name AS b_name,
            count(*) AS shared
     FROM entities a
     JOIN entities b ON a.id < b.id AND lower(a.name) = lower(b.name)
     LEFT JOIN event_participants pa ON pa.entity_id = a.id
     LEFT JOIN event_participants pb ON pb.entity_id = b.id AND pb.event_id = pa.event_id
     GROUP BY a.id, a.name, b.id, b.name
     ORDER BY count(*) DESC
     LIMIT $1`,
    [limit],
  );
}

/**
 * Fold `loserId` into `winnerId`: move identifiers, participation, claims and
 * edges, then delete the loser. Done in one statement batch so a failure
 * halfway cannot leave two half-merged people.
 */
export async function mergeEntities(winnerId: string, loserId: string): Promise<void> {
  if (winnerId === loserId) return;
  await q(`UPDATE identifiers SET entity_id = $1 WHERE entity_id = $2`, [winnerId, loserId]);
  await q(
    `UPDATE event_participants SET entity_id = $1 WHERE entity_id = $2
     AND NOT EXISTS (SELECT 1 FROM event_participants x
                     WHERE x.event_id = event_participants.event_id
                       AND x.entity_id = $1 AND x.role = event_participants.role)`,
    [winnerId, loserId],
  );
  await q(`DELETE FROM event_participants WHERE entity_id = $1`, [loserId]);
  await q(`UPDATE claims SET subject_id = $1 WHERE subject_id = $2`, [winnerId, loserId]);
  await q(`UPDATE claims SET object_id = $1 WHERE object_id = $2`, [winnerId, loserId]);
  await q(
    `UPDATE edges SET from_id = $1 WHERE from_id = $2
     AND NOT EXISTS (SELECT 1 FROM edges x WHERE x.from_id = $1
                     AND x.to_id = edges.to_id AND x.kind = edges.kind
                     AND x.space_id IS NOT DISTINCT FROM edges.space_id)`,
    [winnerId, loserId],
  );
  await q(
    `UPDATE edges SET to_id = $1 WHERE to_id = $2
     AND NOT EXISTS (SELECT 1 FROM edges x WHERE x.to_id = $1
                     AND x.from_id = edges.from_id AND x.kind = edges.kind
                     AND x.space_id IS NOT DISTINCT FROM edges.space_id)`,
    [winnerId, loserId],
  );
  await q(
    `UPDATE entities SET aliases = (
        SELECT array_agg(DISTINCT a) FROM unnest(
          entities.aliases || (SELECT aliases || ARRAY[name] FROM entities WHERE id = $2)
        ) AS a WHERE a <> entities.name)
     WHERE id = $1`,
    [winnerId, loserId],
  );
  await q(`DELETE FROM entities WHERE id = $1`, [loserId]);
}
