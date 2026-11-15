/**
 * On-device habitat server. Same routes and validation as the original Fastify server, but it runs
 * inside the browser so the console works fully offline: the wearable simulation ticks at 1 Hz,
 * and the care log / checks persist in localStorage.
 */
import {
  BODY_ZONES,
  TASKS,
  careLevels,
  evaluateCheck,
  pvtStats,
  type Acvpu,
  type CheckInput,
  type PvtResult,
  type Symptom,
  type TaskId,
} from '@/engine';
import { OSDR_SOURCES, TIMEPOINTS, crewList, labsFor, solarEventAt, spaceWeatherSummary } from './data';
import { addCare, addCheck, checksFor, intakeSummary, resetCrew, type CareType } from './store';
import { SCENARIOS, allSnapshots, initTelemetry, setConsciousness, setScenario, snapshot, tick, vitalsNow, type Scenario } from './telemetry';

const TELEMETRY_HZ = 1;
const DEFAULT_LAB_TIMEPOINT = 'R+1';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let started = false;
const listeners = new Set<(frames: unknown[]) => void>();

function start() {
  if (started) return;
  started = true;
  initTelemetry(crewList());
  setInterval(() => {
    tick();
    const frames = frames_();
    listeners.forEach((l) => l(frames));
  }, 1000 / TELEMETRY_HZ);
}

function frames_() {
  return allSnapshots().map((f) => {
    const last = checksFor(f.id)[0];
    return { ...f, lastCheck: last ? { id: last.id, verdict: last.verdict, task: last.task, timestamp: last.timestamp, pvt: last.pvt } : null };
  });
}

/** Live telemetry for the whole crew (1 Hz). Returns an unsubscribe function. */
export function subscribeTelemetry(fn: (frames: unknown[]) => void) {
  start();
  listeners.add(fn);
  fn(frames_());
  return () => void listeners.delete(fn);
}

function crewOr404(id: string) {
  const c = crewList().find((x) => x.id === id);
  if (!c) throw new HttpError(404, `Unknown crew member ${id}`);
  return c;
}

function crewState(id: string) {
  const c = crewOr404(id);
  const intake = intakeSummary(id);
  return {
    ...c,
    ...snapshot(id),
    intake,
    levels: careLevels(intake.waterMlLast3h, intake.minutesSinceMeal, intake.exerciseMinToday),
    lastCheck: checksFor(id)[0] ?? null,
  };
}

interface CheckBody {
  task: TaskId;
  pvt: PvtResult;
  symptoms: Symptom[];
  sleepHours?: number;
  consciousness?: Acvpu;
  missionTime?: string;
}

const bad = (m: string) => new HttpError(400, m);

/** Route handler mirroring the original REST API (method + path + JSON body). */
export function handle(method: string, path: string, body?: any): unknown {
  start();
  const url = new URL(path, 'http://habitat');
  const p = url.pathname.replace(/^\/api/, '');
  const m = p.match(/^\/crew\/([^/]+)(?:\/(\w+))?$/);

  if (method === 'GET' && p === '/health') return { ok: true, name: 'astro-care habitat server' };
  if (method === 'GET' && p === '/meta')
    return {
      tasks: Object.values(TASKS),
      bodyZones: BODY_ZONES,
      timepoints: TIMEPOINTS,
      scenarios: SCENARIOS,
      lanHosts: typeof location !== 'undefined' ? [location.origin] : [],
      sources: { osdr: OSDR_SOURCES, donki: 'https://api.nasa.gov (DONKI, CCMC)' },
    };
  if (method === 'GET' && p === '/crew') return crewList().map((c) => crewState(c.id));
  if (method === 'GET' && p === '/space-weather') {
    const at = url.searchParams.get('at');
    return { ...spaceWeatherSummary(), activeAt: at ? solarEventAt(at) : null };
  }
  if (method === 'GET' && p === '/checks') return checksFor(url.searchParams.get('crewId') ?? undefined);

  if (m) {
    const [, id, action] = m;
    const c = crewOr404(id);
    if (!action && method === 'GET') return crewState(id);
    if (action === 'labs' && method === 'GET')
      return { sources: OSDR_SOURCES, rows: labsFor(id, url.searchParams.get('timepoint') ?? DEFAULT_LAB_TIMEPOINT) };
    if (action === 'care' && method === 'POST') {
      const { type, value, at } = (body ?? {}) as { type: CareType; value: number; at?: string };
      if (!['water', 'food', 'exercise', 'urine', 'stool', 'sleep'].includes(type) || typeof value !== 'number')
        throw bad('type and numeric value required');
      addCare({ crewId: id, type, value, at: at ?? new Date().toISOString() });
      if (type === 'water' && snapshot(id).scenario === 'dehydrated' && intakeSummary(id).waterMlLast3h >= 500) setScenario(id, 'nominal');
      return crewState(id);
    }
    if (action === 'scenario' && method === 'PUT') {
      if (!SCENARIOS.includes(body?.scenario)) throw bad(`scenario must be one of ${SCENARIOS.join(', ')}`);
      setScenario(id, body.scenario as Scenario);
      return crewState(id);
    }
    if (action === 'reset' && method === 'POST') {
      resetCrew(id);
      setScenario(id, 'nominal');
      setConsciousness(id, 'A');
      return crewState(id);
    }
    if (action === 'check' && method === 'POST') {
      const b = body as CheckBody;
      if (!b || !TASKS[b.task]) throw bad(`task must be one of ${Object.keys(TASKS).join(', ')}`);
      const rts = b.pvt?.reactionTimesMs;
      if (!Array.isArray(rts) || rts.length > 500 || !rts.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 60_000))
        throw bad('pvt.reactionTimesMs must be an array of reaction times in ms (0–60000)');
      if (!Number.isInteger(b.pvt.falseStarts) || b.pvt.falseStarts < 0) throw bad('pvt.falseStarts must be a non-negative integer');
      if (b.symptoms !== undefined && !Array.isArray(b.symptoms)) throw bad('symptoms must be an array');
      if (b.sleepHours !== undefined && !(typeof b.sleepHours === 'number' && b.sleepHours >= 0 && b.sleepHours <= 24))
        throw bad('sleepHours must be 0–24');
      if (b.consciousness) setConsciousness(c.id, b.consciousness);
      const vitals = vitalsNow(c.id)!;
      const intake = c.guest
        ? { waterMlLast3h: 500, minutesSinceMeal: 90, minutesSinceVoid: 30, urineColor: 2, sleepHours: 7 }
        : intakeSummary(c.id);
      const input: CheckInput = {
        task: b.task,
        vitals,
        baseline: c.baseline,
        pvt: b.pvt,
        pvtBaselineMedianMs: c.pvtBaselineMedianMs,
        intake: { waterMlLast3h: intake.waterMlLast3h, minutesSinceMeal: intake.minutesSinceMeal, minutesSinceVoid: intake.minutesSinceVoid, urineColor: intake.urineColor },
        symptoms: b.symptoms ?? [],
        sleepHours: b.sleepHours ?? intake.sleepHours,
        solarEvent: b.missionTime ? solarEventAt(b.missionTime) : null,
      };
      const record = { ...evaluateCheck(input), id: crypto.randomUUID(), crewId: c.id, pvt: rts.length ? pvtStats(b.pvt, c.pvtBaselineMedianMs) : undefined };
      addCheck(record);
      return { ...record, input };
    }
  }
  throw new HttpError(404, `No route ${method} ${p}`);
}
