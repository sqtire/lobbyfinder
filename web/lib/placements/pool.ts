/**
 * Manual mappool input. One map per line:
 *
 *   NM1 https://osu.ppy.sh/beatmapsets/123#osu/456
 *   NM1 T2 7891011                 ← the lower (Tier 2) difficulty of the same slot
 *   HD1 4567890 5678901            ← or several ids on one line: upper first, then lower
 *   TB  https://osu.ppy.sh/b/999
 *
 * Optional stage sections, when rounds use different pools:
 *
 *   [Round 1]
 *   NM1 …
 *   [Round 2]
 *   NM1 …
 *
 * Maps above the first section header apply to every stage. Labels are the
 * non-id tokens on the line; anything starting with "TB" is the tiebreaker.
 * The FIRST id on a line is the upper (Tier 1) difficulty; every later id is a
 * lower tier — that order decides which scores get the lower-pool multiplier.
 */

import type { PoolMap, PoolParse } from "./types";

const URL_RE = /osu\.ppy\.sh\/(?:beatmapsets\/\d+#[a-z]+\/(\d+)|b(?:eatmaps)?\/(\d+))/i;

export function beatmapIdFromToken(tok: string): number | null {
  const m = tok.match(URL_RE);
  if (m) return Number(m[1] ?? m[2]);
  if (/^\d{3,9}$/.test(tok)) return Number(tok);
  return null;
}

export function parsePool(text: string): PoolParse {
  const maps: PoolMap[] = [];
  const warnings: string[] = [];
  let stage: string | null = null;
  let order = 0;
  const seen = new Map<number, string>();
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li]!.trim();
    if (!raw || raw.startsWith("//")) continue;
    const section = raw.match(/^\[(.+)\]$/) ?? raw.match(/^#+\s*(.+)$/) ?? (raw.endsWith(":") && !/\d{3,}/.test(raw) ? [raw, raw.slice(0, -1)] : null);
    if (section) {
      stage = section[1]!.trim();
      continue;
    }
    const tokens = raw.split(/[\s,;|]+/).filter(Boolean);
    const ids: number[] = [];
    const labelParts: string[] = [];
    let explicitTier: number | null = null; // "T2" / "tier2" / "lower" / "upper" tokens name the tier instead of being part of the label
    for (const t of tokens) {
      const id = beatmapIdFromToken(t);
      if (id !== null) ids.push(id);
      else if (/^(t|tier)\s*([1-9])$/i.test(t)) explicitTier = Number(t.match(/([1-9])$/)![1]) - 1;
      else if (/^upper$/i.test(t)) explicitTier = 0;
      else if (/^lower$/i.test(t)) explicitTier = 1;
      else if (!/^[-=:>]+$/.test(t)) labelParts.push(t);
    }
    if (ids.length === 0) {
      warnings.push(`Line ${li + 1}: no beatmap id or link found ("${raw.slice(0, 40)}").`);
      continue;
    }
    const label = labelParts.join(" ") || `#${order + 1}`;
    const slot = `${stage ?? "*"}|${label.toLowerCase()}`;
    let tier = explicitTier ?? maps.filter((m) => m.slot === slot).length; // a slot may continue on a later line ("NM1 T2 …")
    for (const id of ids) {
      const dupe = seen.get(id);
      if (dupe) {
        warnings.push(`Line ${li + 1}: beatmap ${id} already listed as ${dupe}; keeping the first.`);
        continue;
      }
      seen.set(id, label);
      maps.push({ beatmap_id: id, label, stage, is_tb: /^tb/i.test(label), order: order++, tier: tier++, slot });
    }
  }
  if (maps.length === 0) warnings.push("The mappool is empty — paste at least one map.");
  return { maps, warnings };
}

/** Maps that apply to `stage` (global maps plus that stage's section). */
export function poolForStage(maps: PoolMap[], stage: string): Map<number, PoolMap> {
  const out = new Map<number, PoolMap>();
  const key = stage.trim().toLowerCase();
  for (const m of maps) {
    if (m.stage === null || m.stage.trim().toLowerCase() === key) out.set(m.beatmap_id, m);
  }
  return out;
}
