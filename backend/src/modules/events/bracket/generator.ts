import { getDb } from '../../../shared/db/client'
import { canOfficiate, type MatchTier } from '../../../shared/tiers'
import type { FixtureSource } from '../../../shared/db/types'
import { planBracket, type PlannedSource } from './planner'
import { scheduleFixtures } from './scheduler'

/** Used when the event has no match_duration_minutes set. */
const DEFAULT_SLOT_MINUTES = 15

export type GenerateResult =
  | {
      ok: true
      fixtures: number
      matches: number
      fell_back: boolean
      fallback_reason: string | null
    }
  | { ok: false; code: number; error: string }

/**
 * Convert a planner source into the stored jsonb shape. `winner_of` keys become
 * real fixture UUIDs once known; before that they are written as an empty string
 * and rewritten in pass 2.
 */
function toStoredSource(source: PlannedSource, idByKey: Map<string, string>): FixtureSource {
  if (source.type === 'team') return { type: 'team', team_id: source.team_id }
  if (source.type === 'qualifier') return { type: 'qualifier', seed: source.seed }
  return { type: 'winner_of', fixture_id: idByKey.get(source.ref) ?? '' }
}

/**
 * Turn an event's registered teams into a full set of fixtures, and create the
 * `matches` rows for every fixture whose teams are already known (the group
 * stage, or the first round of a pure knockout).
 *
 * Everything happens in one transaction. In particular, if ANY match would
 * exceed its assigned referee's tier the whole thing is refused — the third
 * enforcement point of spec §3.1.1.
 */
export async function generateFixtures(eventId: string): Promise<GenerateResult> {
  const db = getDb()

  const event = await db
    .selectFrom('events')
    .select([
      'id',
      'sport_id',
      'format',
      'tier',
      'match_format',
      'match_duration_minutes',
      'starts_at',
      'venue',
    ])
    .where('id', '=', eventId)
    .executeTakeFirst()

  if (!event) return { ok: false, code: 404, error: 'Event not found' }

  if (event.format !== 'knockout' && event.format !== 'group_knockout') {
    return {
      ok: false,
      code: 400,
      error: `Fixture generation supports 'knockout' and 'group_knockout', not '${event.format}'`,
    }
  }

  // ── Regeneration guard ────────────────────────────────────────────────────
  const started = await db
    .selectFrom('matches')
    .select('id')
    .where('event_id', '=', eventId)
    .where('status', '!=', 'scheduled')
    .executeTakeFirst()

  if (started) {
    return {
      ok: false,
      code: 409,
      error: 'A match has already kicked off — fixtures can no longer be regenerated',
    }
  }

  // ── Inputs ────────────────────────────────────────────────────────────────
  const registered = await db
    .selectFrom('event_teams')
    .select(['team_id', 'seed'])
    .where('event_id', '=', eventId)
    .orderBy('seed', 'asc')
    .orderBy('team_id', 'asc')
    .execute()

  if (registered.length < 2) {
    return {
      ok: false,
      code: 400,
      error: `A tournament needs at least 2 registered teams (got ${registered.length})`,
    }
  }

  const referees = await db
    .selectFrom('event_referees as er')
    .innerJoin('users as u', 'u.id', 'er.user_id')
    .select(['er.user_id', 'er.pitch_label', 'u.role', 'u.referee_tier', 'u.name'])
    .where('er.event_id', '=', eventId)
    .execute()

  const withPitch = referees.filter((r) => r.pitch_label)
  if (withPitch.length === 0) {
    return {
      ok: false,
      code: 400,
      error: 'Assign at least one referee with a pitch label before generating fixtures',
    }
  }

  // ── Tier check, before writing anything ───────────────────────────────────
  // Every generated match inherits events.tier, so every assigned referee must
  // be able to officiate it. Admins bypass, as everywhere else.
  const eventTier = event.tier as MatchTier
  for (const r of withPitch) {
    if (r.role === 'admin') continue
    if (!canOfficiate(r.referee_tier, eventTier)) {
      return {
        ok: false,
        code: 409,
        error: `${r.name} (tier ${r.referee_tier ?? 'none'}) cannot officiate a '${eventTier}' match — lower the event tier or change referees`,
      }
    }
  }

  // ── Plan and schedule ─────────────────────────────────────────────────────
  const plan = planBracket(
    registered.map((r) => r.team_id),
    event.format
  )

  const pitches = [...new Set(withPitch.map((r) => r.pitch_label as string))].sort()
  const refereeByPitch = new Map(withPitch.map((r) => [r.pitch_label as string, r.user_id]))

  let scheduled
  try {
    scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches,
      startsAt: event.starts_at ?? new Date(),
      slotMinutes: event.match_duration_minutes ?? DEFAULT_SLOT_MINUTES,
    })
  } catch (e) {
    return { ok: false, code: 400, error: (e as Error).message }
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  const written = await db.transaction().execute(async (trx) => {
    // Clear any previous, unstarted bracket. event_fixtures.match_id is
    // ON DELETE SET NULL, so fixtures must go before their matches.
    await trx.deleteFrom('event_fixtures').where('event_id', '=', eventId).execute()
    await trx.deleteFrom('matches').where('event_id', '=', eventId).execute()

    // Record group membership so standings and the UI can group teams.
    await trx
      .updateTable('event_teams')
      .set({ group_no: null })
      .where('event_id', '=', eventId)
      .execute()
    for (const g of plan.groups) {
      await trx
        .updateTable('event_teams')
        .set({ group_no: g.group })
        .where('event_id', '=', eventId)
        .where('team_id', 'in', g.team_ids)
        .execute()
    }

    // Pass 1 — insert every fixture. winner_of sources get a placeholder because
    // the referenced fixture's real UUID isn't known yet.
    const idByKey = new Map<string, string>()
    for (const f of scheduled) {
      const row = await trx
        .insertInto('event_fixtures')
        .values({
          event_id: eventId,
          round: f.round,
          slot_no: f.slot_no,
          pitch_label: f.pitch_label,
          scheduled_at: f.scheduled_at,
          referee_id: refereeByPitch.get(f.pitch_label) ?? null,
          home_source: toStoredSource(f.home, idByKey),
          away_source: toStoredSource(f.away, idByKey),
          home_team_id: f.home.type === 'team' ? f.home.team_id : null,
          away_team_id: f.away.type === 'team' ? f.away.team_id : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      idByKey.set(f.key, row.id)
    }

    // Pass 2 — rewrite winner_of sources now that every fixture has a UUID.
    for (const f of scheduled) {
      if (f.home.type !== 'winner_of' && f.away.type !== 'winner_of') continue
      await trx
        .updateTable('event_fixtures')
        .set({
          home_source: toStoredSource(f.home, idByKey),
          away_source: toStoredSource(f.away, idByKey),
        })
        .where('id', '=', idByKey.get(f.key)!)
        .execute()
    }

    // Pass 3 — create matches for fixtures whose teams are already known.
    let matchCount = 0
    for (const f of scheduled) {
      if (f.home.type !== 'team' || f.away.type !== 'team') continue
      const match = await trx
        .insertInto('matches')
        .values({
          event_id: eventId,
          sport_id: event.sport_id,
          home_team_id: f.home.team_id,
          away_team_id: f.away.team_id,
          venue: event.venue,
          round: f.round,
          scheduled_at: f.scheduled_at,
          status: 'scheduled',
          tier: eventTier,
          format: event.match_format,
          duration_minutes: event.match_duration_minutes,
          referee_id: refereeByPitch.get(f.pitch_label) ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      await trx
        .updateTable('event_fixtures')
        .set({ match_id: match.id, updated_at: new Date() })
        .where('id', '=', idByKey.get(f.key)!)
        .execute()
      matchCount++
    }

    return { fixtures: scheduled.length, matches: matchCount }
  })

  return {
    ok: true,
    fixtures: written.fixtures,
    matches: written.matches,
    fell_back: plan.fell_back,
    fallback_reason: plan.fallback_reason,
  }
}
