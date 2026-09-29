/**
 * Score multipliers — normalize scores before any stat is computed (e.g. a
 * difficulty-adjusted CS lowers the max score, EZ halves it in lazer). Manual
 * input, pasted from the ref sheet's "Mod Multipliers" table or typed:
 *
 *   NM1 T1 1.176        slot NM1, upper (Tier 1) difficulty
 *   NM1 T2 1.333        slot NM1, lower (Tier 2) difficulty
 *   FM1 EZ 1.25         slot FM1, scores set with EZ
 *   * EZ 1.75           any slot, scores set with EZ (a "universal" multiplier)
 *   * HDHR 0.9434       mod combos are written together
 *   Round 1  NM1  T1  1.176   a leading stage limits the rule to that stage (tab-separated
 *                             rows copied from Google Sheets work as they are)
 *
 * For a score, at most one "base" rule (no mods: slot / tier / stage) and one
 * "mod" rule (the one requiring the most mods the score has) apply; the more
 * specific rule wins inside each group (stage > slot > tier > wildcard, later
 * line on a tie) and the two multiply. Header rows and rows without a number
 * are skipped.
 *
 * Pure module (no node imports) — shared by the engine, the preview route and the panel.
 */

import type { MultRule } from "./types";

export interface MultParse {
  rules: MultRule[];
  warnings: string[];
}

const TIER_RE = /^(?:t|tier)\s*([1-9])$/i;
const FACTOR_RE = /^[x×]?(\d+(?:\.\d+)?|\.\d+)x?$/i;
const SLOT_RE = /^(?:[a-z]{2}\d+|tb\d*)$/i;
const MODS_RE = /^([a-z]{2})+(\[[^\]]*\])?$/i;

export function parseMultipliers(text: string, poolLabels: string[] = []): MultParse {
  const rules: MultRule[] = [];
  const warnings: string[] = [];
  const labels = new Map(poolLabels.map((l) => [l.toLowerCase(), l]));
  const seen = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li]!.trim();
    if (!raw || raw.startsWith("//")) continue;
    const cells = (raw.includes("\t") ? raw.split("\t") : raw.split(/[\s,;|]+/)).map((c) => c.trim()).filter(Boolean);
    // the multiplier is the LAST cell (a row whose multiplier cell is blank must not borrow its row number)
    const fi = cells.length && FACTOR_RE.test(cells[cells.length - 1]!) ? cells.length - 1 : -1;
    if (fi < 0) {
      if (!/mod|multi|slot|stage|pick|#/i.test(raw)) warnings.push(`Multipliers line ${li + 1}: no multiplier number ("${raw.slice(0, 40)}") — skipped.`);
      continue;
    }
    const factor = Number(cells[fi]!.replace(/[x×]/gi, ""));
    if (!(factor > 0) || factor > 20) {
      warnings.push(`Multipliers line ${li + 1}: ${cells[fi]} isn't a sensible multiplier — skipped.`);
      continue;
    }
    const rest = cells.filter((_, i) => i !== fi);
    // the slot label: a pool label, or anything slot-shaped (NM1, HD2, TB); "*" = every slot
    let labelIdx = rest.findIndex((c) => labels.has(c.toLowerCase()) || (SLOT_RE.test(c) && !TIER_RE.test(c)) || /^(\*|all|any)$/i.test(c));
    let label: string | null = null;
    let stage: string | null = null;
    let tail = rest;
    if (labelIdx >= 0) {
      const c = rest[labelIdx]!;
      label = /^(\*|all|any)$/i.test(c) ? null : labels.get(c.toLowerCase()) ?? c.toUpperCase();
      const before = rest.slice(0, labelIdx).join(" ").trim();
      if (before && !/^\d+$/.test(before)) stage = before; // a leading row number ("1") is not a stage
      tail = rest.slice(labelIdx + 1);
    } else {
      labelIdx = -1;
      while (tail.length > 1 && /^\d+$/.test(tail[0]!)) tail = tail.slice(1); // "1  EZ  1.75" — a leading row number
    }
    let tier: number | null = null;
    const mods: string[] = [];
    const unknown: string[] = [];
    for (const c of tail) {
      const t = c.match(TIER_RE);
      if (t) tier = Number(t[1]) - 1;
      else if (/^upper$/i.test(c)) tier = 0;
      else if (/^lower$/i.test(c)) tier = 1;
      else if (/^nm$/i.test(c)) continue;
      else if (MODS_RE.test(c)) {
        const letters = c.replace(/\[[^\]]*\]$/, "").toUpperCase();
        for (let i = 0; i < letters.length; i += 2) mods.push(letters.slice(i, i + 2));
      } else unknown.push(c);
    }
    if (unknown.length) warnings.push(`Multipliers line ${li + 1}: didn't understand ${unknown.map((u) => `"${u}"`).join(", ")} — the rest of the line was used.`);
    if (labelIdx < 0 && tier === null && mods.length === 0) {
      warnings.push(`Multipliers line ${li + 1}: no slot, tier or mod ("${raw.slice(0, 40)}") — skipped.`);
      continue;
    }
    if (label && poolLabels.length && !labels.has(label.toLowerCase())) warnings.push(`Multipliers line ${li + 1}: ${label} isn't in the pool.`);
    const uniqMods = [...new Set(mods)].sort();
    const key = JSON.stringify([stage?.toLowerCase() ?? null, label?.toLowerCase() ?? null, tier, uniqMods]);
    const dupe = seen.get(key);
    if (dupe !== undefined) warnings.push(`Multipliers line ${li + 1} repeats line ${rules[dupe]!.line} — the later one is used.`);
    seen.set(key, rules.length);
    rules.push({ stage, label, tier, mods: uniqMods, factor, line: li + 1, text: raw.replace(/\t/g, " ") });
  }
  return { rules, warnings };
}

const spec = (r: MultRule) => (r.stage ? 4 : 0) + (r.label ? 2 : 0) + (r.tier !== null ? 1 : 0);

function applicable(rules: MultRule[], stage: string | null, label: string, tier: number, mods: string[]) {
  const have = new Set(mods.map((m) => m.toUpperCase()));
  const st = stage?.trim().toLowerCase() ?? null;
  const lb = label.toLowerCase();
  return rules.filter(
    (r) =>
      (r.stage === null || (st !== null && r.stage.trim().toLowerCase() === st)) &&
      (r.label === null || r.label.toLowerCase() === lb) &&
      (r.tier === null || r.tier === tier) &&
      r.mods.every((m) => have.has(m))
  );
}

/** The two rules that apply to a score (either may be null). */
export function matchRules(rules: MultRule[], stage: string | null, label: string, tier: number, mods: string[]): { base: MultRule | null; mod: MultRule | null } {
  if (!rules.length) return { base: null, mod: null };
  const hits = applicable(rules, stage, label, tier, mods);
  let base: MultRule | null = null;
  let mod: MultRule | null = null;
  for (const r of hits) {
    if (r.mods.length === 0) {
      if (!base || spec(r) > spec(base) || (spec(r) === spec(base) && r.line > base.line)) base = r;
    } else if (!mod || r.mods.length > mod.mods.length || (r.mods.length === mod.mods.length && (spec(r) > spec(mod) || (spec(r) === spec(mod) && r.line > mod.line)))) mod = r;
  }
  return { base, mod };
}

export function scoreMultiplier(rules: MultRule[], stage: string | null, label: string, tier: number, mods: string[]): number {
  const { base, mod } = matchRules(rules, stage, label, tier, mods);
  return (base?.factor ?? 1) * (mod?.factor ?? 1);
}

const fmtF = (f: number) => `×${Number(f.toFixed(4))}`;

/** Human summary of what applies to one difficulty across the given stages, e.g. "×1.176 · EZ ×1.25" (universal "*" mod rules left out). */
export function describeMultipliers(rules: MultRule[], stages: string[], label: string, tier: number): string {
  if (!rules.length) return "";
  const ctx = stages.length ? stages : [null];
  const bases = new Set<string>();
  const mods = new Map<string, Set<string>>();
  for (const st of ctx) {
    const base = matchRules(rules.filter((r) => r.mods.length === 0), st, label, tier, []).base;
    if (base && base.factor !== 1) bases.add(fmtF(base.factor));
    const lb = label.toLowerCase();
    const s = st?.trim().toLowerCase() ?? null;
    for (const r of rules) {
      if (!r.mods.length) continue;
      if (r.label === null || r.label.toLowerCase() !== lb) continue; // universal mod rules are listed once, not per map
      if (r.tier !== null && r.tier !== tier) continue;
      if (r.stage !== null && r.stage.trim().toLowerCase() !== s) continue;
      // only the rule that would win for exactly these mods
      const win = matchRules(rules, st, label, tier, r.mods).mod;
      if (win !== r) continue;
      const k = r.mods.join("");
      if (!mods.has(k)) mods.set(k, new Set());
      mods.get(k)!.add(fmtF(r.factor));
    }
  }
  const parts: string[] = [];
  if (bases.size) parts.push([...bases].join(" / "));
  for (const [k, fs] of mods) parts.push(`${k} ${[...fs].join(" / ")}`);
  return parts.join(" · ");
}
