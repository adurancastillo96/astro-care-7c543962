import type { VerdictResult } from '@/engine';

/** Tiny on-device store (browser localStorage): survives reloads, works offline, zero setup. */
const KEY = 'astro-care-store-v1';

export type CareType = 'water' | 'food' | 'exercise' | 'urine' | 'stool' | 'sleep';

export interface CareEntry {
  crewId: string;
  type: CareType;
  value: number; // ml | kcal | minutes | color 1–8 | Bristol 1–7 | hours
  at: string;
}

export interface CheckRecord extends VerdictResult {
  id: string;
  crewId: string;
  pvt?: { medianMs: number; lapses: number; falseStarts: number; errors: number; slowdownPct: number };
}

interface Store {
  care: CareEntry[];
  checks: CheckRecord[];
}

function load(): Store {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) return JSON.parse(raw) as Store;
  } catch {
    /* corrupted or unavailable storage: start fresh */
  }
  return { care: [], checks: [] };
}

let store: Store = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* storage full or unavailable: keep in memory */
  }
}

export function addCare(e: CareEntry) {
  store.care.push(e);
  save();
  return e;
}

export function careFor(crewId: string) {
  return store.care.filter((c) => c.crewId === crewId);
}

export function addCheck(c: CheckRecord) {
  store.checks.unshift(c);
  save();
  return c;
}

export function checksFor(crewId?: string) {
  return crewId ? store.checks.filter((c) => c.crewId === crewId) : store.checks;
}

export function resetCrew(crewId: string) {
  store = {
    care: store.care.filter((c) => c.crewId !== crewId),
    checks: store.checks.filter((c) => c.crewId !== crewId),
  };
  save();
}

/** Derived intake summary used by the readiness check. */
export function intakeSummary(crewId: string, now = new Date()) {
  const entries = careFor(crewId);
  const t = now.getTime();
  const minutesSince = (type: CareType) => {
    const last = entries.filter((e) => e.type === type).at(-1);
    return last ? Math.round((t - new Date(last.at).getTime()) / 60000) : 24 * 60;
  };
  const waterMlLast3h = entries
    .filter((e) => e.type === 'water' && t - new Date(e.at).getTime() <= 3 * 3600_000)
    .reduce((s, e) => s + e.value, 0);
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const exerciseMinToday = entries
    .filter((e) => e.type === 'exercise' && new Date(e.at) >= startOfDay)
    .reduce((s, e) => s + e.value, 0);
  const lastUrine = entries.filter((e) => e.type === 'urine').at(-1);
  const lastSleep = entries.filter((e) => e.type === 'sleep').at(-1);
  const lastStool = entries.filter((e) => e.type === 'stool').at(-1);
  return {
    waterMlLast3h,
    minutesSinceMeal: minutesSince('food'),
    minutesSinceVoid: minutesSince('urine'),
    minutesSinceStool: minutesSince('stool'),
    urineColor: lastUrine?.value,
    lastBristol: lastStool?.value,
    sleepHours: lastSleep?.value,
    exerciseMinToday,
  };
}
