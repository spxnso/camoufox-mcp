// Humanized pointer input for drag and coordinate-click actions. Playwright's
// mouse.move(x, y, { steps }) interpolates linearly, which bot detectors read
// as machine input. These helpers emit the same event stream a hand produces:
// many pointermove events with variable velocity, a slight arc, small jitter,
// a hold after pointerdown, and an overshoot that is corrected before release.

import { withTimeout } from "./utils.js";


// Minimal slice of Playwright's Mouse used here, so unit tests can drive the
// same code with a fake.
export interface PointerMouse {
  move(x: number, y: number): Promise<void>;
  down(): Promise<void>;
  up(): Promise<void>;
}

export interface PointerPoint {
  x: number;
  y: number;
}

export interface DragPathPoint extends PointerPoint {
  delayMs: number;
}

export interface DragPath {
  points: DragPathPoint[];
  durationMs: number;
}

export const DRAG_MIN_MOVES = 40;
export const DRAG_MAX_MOVES = 80;
export const DRAG_MIN_DURATION_MS = 800;
export const DRAG_MAX_DURATION_MS = 1500;
export const DRAG_HOLD_MIN_MS = 100;
export const DRAG_HOLD_MAX_MS = 300;
export const DRAG_OVERSHOOT_MIN_PX = 3;
export const DRAG_OVERSHOOT_MAX_PX = 5;
export const DRAG_JITTER_PX = 3;
// Cap on the vertical arc amplitude; the arc itself scales with drag distance.
export const DRAG_MAX_ARC_PX = 24;

const OVERSHOOT_SETTLE_MIN_MS = 20;
const OVERSHOOT_SETTLE_MAX_MS = 80;
const CLICK_JITTER_MIN_MOVES = 1;
const CLICK_JITTER_MAX_MOVES = 3;
const CLICK_JITTER_MIN_MS = 20;
const CLICK_JITTER_MAX_MS = 60;

export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

export interface PointerDeps {
  sleep?: Sleep;
  rand?: () => number;
}

function randInt(min: number, max: number, rand: () => number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// A drag path from `from` to `to`: 40-80 points spread over 800-1500 ms. Each
// point carries the delay before it; the eased timeline gives variable
// velocity, so the delays are not constant. The last point is exactly `to`:
// jitter only applies to intermediate points, so the drag ends on target and
// the delays sum to durationMs.
export function buildDragPath(from: PointerPoint, to: PointerPoint, rand: () => number = Math.random): DragPath {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);

  const moves = randInt(DRAG_MIN_MOVES, DRAG_MAX_MOVES, rand);
  const durationMs = randInt(DRAG_MIN_DURATION_MS, DRAG_MAX_DURATION_MS, rand);
  const arcAmplitude = (rand() * 2 - 1) * Math.min(0.06 * distance, DRAG_MAX_ARC_PX);

  const eased: number[] = [];
  let previous = 0;
  for (let i = 1; i <= moves; i += 1) {
    const t = i / moves;
    const smooth = t * t * (3 - 2 * t);
    const wobble = (rand() * 2 - 1) * 0.15;
    // Monotonic and clamped so per-step delays never go negative.
    const value = i === moves ? 1 : clamp(Math.max(previous, smooth + wobble), 0, 1);
    eased.push(value);
    previous = value;
  }

  const points: DragPathPoint[] = eased.map((value, index) => {
    const t = (index + 1) / moves;
    const last = index === eased.length - 1;
    const jitterX = last ? 0 : (rand() * 2 - 1) * DRAG_JITTER_PX;
    const jitterY = last ? 0 : (rand() * 2 - 1) * DRAG_JITTER_PX;
    const previousValue = index === 0 ? 0 : eased[index - 1];
    return {
      x: from.x + dx * value + jitterX,
      y: from.y + dy * value + arcAmplitude * Math.sin(Math.PI * t) + jitterY,
      delayMs: durationMs * (value - previousValue),
    };
  });

  return { points, durationMs };
}

// Humanized drag: move to the start, pointerdown, hold 100-300 ms, sweep
// through the path, overshoot 3-5 px past the target and correct back, then
// pointerup. The whole gesture is bounded by one timeout.
export async function humanizedDrag(
  mouse: PointerMouse,
  from: PointerPoint,
  to: PointerPoint,
  timeout: number,
  deps: PointerDeps = {},
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const rand = deps.rand ?? Math.random;

  await withTimeout((async () => {
    const deadline = Date.now() + timeout;
    const remaining = (): number => Math.max(0, deadline - Date.now());

    await mouse.move(from.x, from.y);
    await mouse.down();
    await sleep(Math.min(randInt(DRAG_HOLD_MIN_MS, DRAG_HOLD_MAX_MS, rand), remaining()));

    const path = buildDragPath(from, to, rand);
    // Compress the schedule into whatever budget is left after the hold, so a
    // short caller timeout still gets a complete gesture instead of a stall.
    const budget = Math.max(0, remaining() - OVERSHOOT_SETTLE_MAX_MS * 2);
    const scale = path.durationMs > 0 && budget < path.durationMs ? budget / path.durationMs : 1;
    for (const point of path.points) {
      await mouse.move(point.x, point.y);
      const delay = point.delayMs * scale;
      if (delay > 0) {
        await sleep(Math.min(delay, remaining()));
      }
    }

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    const ux = distance > 0 ? dx / distance : 1;
    const uy = distance > 0 ? dy / distance : 0;
    const overshoot = randInt(DRAG_OVERSHOOT_MIN_PX, DRAG_OVERSHOOT_MAX_PX, rand);
    await mouse.move(to.x + ux * overshoot, to.y + uy * overshoot);
    await sleep(Math.min(randInt(OVERSHOOT_SETTLE_MIN_MS, OVERSHOOT_SETTLE_MAX_MS, rand), remaining()));
    await mouse.move(to.x, to.y);
    await sleep(Math.min(randInt(OVERSHOOT_SETTLE_MIN_MS, OVERSHOOT_SETTLE_MAX_MS, rand), remaining()));
    await mouse.up();
  })(), timeout, "Drag action");
}

// Humanized coordinate click for canvas-rendered widgets (e.g. Datadome
// sliders) that have no DOM element to click: a short jitter around the point,
// then pointerdown and pointerup at exactly (x, y) with a 100-300 ms hold.
export async function humanizedClickAt(
  mouse: PointerMouse,
  x: number,
  y: number,
  timeout: number,
  deps: PointerDeps = {},
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const rand = deps.rand ?? Math.random;

  await withTimeout((async () => {
    const deadline = Date.now() + timeout;
    const remaining = (): number => Math.max(0, deadline - Date.now());

    await mouse.move(x, y);
    const jitters = randInt(CLICK_JITTER_MIN_MOVES, CLICK_JITTER_MAX_MOVES, rand);
    for (let i = 0; i < jitters; i += 1) {
      await mouse.move(x + (rand() * 2 - 1) * DRAG_JITTER_PX, y + (rand() * 2 - 1) * DRAG_JITTER_PX);
      await sleep(Math.min(randInt(CLICK_JITTER_MIN_MS, CLICK_JITTER_MAX_MS, rand), remaining()));
    }
    await mouse.move(x, y);
    await mouse.down();
    await sleep(Math.min(randInt(DRAG_HOLD_MIN_MS, DRAG_HOLD_MAX_MS, rand), remaining()));
    await mouse.up();
  })(), timeout, "ClickAt action");
}
