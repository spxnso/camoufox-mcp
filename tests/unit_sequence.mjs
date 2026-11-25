import assert from "node:assert/strict";
import { activateElement, findDisallowedAction, runSequenceActionsWithBudget, sequenceTimeoutBudget } from "../dist/sequence.js";
import { OperationTimeoutError, isOperationTimeout } from "../dist/utils.js";
import { installRequestGuard } from "../dist/browser-runtime.js";
import { DEFAULT_ACTION_TIMEOUT_MS, MAX_SEQUENCE_ACTIONS, SEQUENCE_TIMEOUT_MS } from "../dist/config.js";

// Finding #9: the schema allows up to MAX_SEQUENCE_ACTIONS (25) actions, but the
// sequence timeout budget must be large enough to admit that many at the default
// per-action timeout. Previously the default SEQUENCE_TIMEOUT_MS was 120000ms,
// which rejected any sequence with 13+ default-timeout actions.
function defaultClickAction() {
  return { type: "click", selector: "#a" };
}

// 25 default-timeout actions (25 * 10000 = 250000) must fit the default budget.
const maxActions = Array.from({ length: MAX_SEQUENCE_ACTIONS }, defaultClickAction);
assert.equal(
  sequenceTimeoutBudget(maxActions),
  MAX_SEQUENCE_ACTIONS * DEFAULT_ACTION_TIMEOUT_MS,
  "budget should sum default per-action timeouts",
);
assert.ok(
  sequenceTimeoutBudget(maxActions) <= SEQUENCE_TIMEOUT_MS,
  `default SEQUENCE_TIMEOUT_MS (${SEQUENCE_TIMEOUT_MS}ms) must admit MAX_SEQUENCE_ACTIONS (${MAX_SEQUENCE_ACTIONS}) at the default action timeout`,
);

// 26 actions should exceed MAX_SEQUENCE_ACTIONS logically but the budget check is
// purely additive; verify the budget math scales linearly.
assert.equal(sequenceTimeoutBudget(Array.from({ length: 26 }, defaultClickAction)), 260000);

const passingGuard = { assertAllowed() {}, async settle() {}, async assertSettled() {}, takeBlock() {}, reset() {} };

let guardHttpRequest;
const requestGuard = await installRequestGuard({
  on() {},
  async route(_pattern, handler) { guardHttpRequest = handler; },
  async routeWebSocket() {},
});
const actionError = new Error("Selector wait failed after a private request");
let actionAttempts = 0;
let abortedRequests = 0;
const failingPage = {
  async waitForSelector() {
    actionAttempts += 1;
    await guardHttpRequest({
      request: () => ({ url: () => "http://blocked.localhost:80/private?token=sequence-policy-secret#fragment" }),
      async abort() { abortedRequests += 1; },
    });
    throw actionError;
  },
};

// A blocked request can fail the action before the normal post-action guard
// check. Preserve the actionable policy error and never replay the action.
await assert.rejects(runSequenceActionsWithBudget(failingPage, requestGuard, [
  { type: "waitFor", selector: "#missing", timeout: 1000 },
  { type: "waitFor", selector: "#must-not-run", timeout: 1000 },
], [], []), (error) => {
  assert.match(error.message, /Blocked unsafe browser request/);
  assert.match(error.message, /CAMOUFOX_MCP_ALLOWED_PRIVATE_HOSTS=blocked\.localhost/);
  assert.match(error.message, /restart/);
  assert.doesNotMatch(error.message, /sequence-policy-secret|#fragment/);
  return true;
});
assert.equal(actionAttempts, 1);
assert.equal(abortedRequests, 1);

await assert.rejects(runSequenceActionsWithBudget({
  async waitForSelector() { throw actionError; },
}, passingGuard, [
  { type: "waitFor", selector: "#missing", timeout: 1000 },
], [], []), (error) => error === actionError, "ordinary action errors retain their original identity");

await assert.rejects(runSequenceActionsWithBudget({
  keyboard: { press: () => new Promise(() => {}) },
}, passingGuard, [
  { type: "press", key: "Enter", timeout: 1 },
], [], []), (error) => {
  assert.match(error.message, /Press action timed out\./, "local action timeouts retain their original message");
  assert.ok(isOperationTimeout(error), "local timeouts are identified by type");
  return true;
});

// Page code can throw any text. Only this server's own deadline counts as a
// local timeout, so a page cannot close a session by imitating the message.
assert.equal(isOperationTimeout(new Error("Something timed out.")), false);
assert.equal(isOperationTimeout(new OperationTimeoutError("Click action")), true);

await assert.rejects(runSequenceActionsWithBudget({
  mouse: { wheel: () => new Promise(() => {}) },
}, passingGuard, [
  { type: "scroll", deltaX: 0, deltaY: 100, timeout: 1 },
], [], []), /Scroll action timed out\./, "a hung wheel scroll is bounded");

// evaluate is refused before launch unless enabled, whatever precedes it.
assert.match(findDisallowedAction([{ type: "click", selector: "#a" }, { type: "evaluate", expression: "1" }]) ?? "", /Evaluate action is disabled/);
assert.equal(findDisallowedAction([{ type: "click", selector: "#a" }]), undefined);

// clickMode "auto": a failed trial dispatched nothing, so the DOM fallback is
// safe. Once the trial passes, a failing pointer click may already have
// delivered events and must not be followed by a second, DOM click.
function fakeClickPage({ trialFails, clickFails }) {
  const calls = [];
  const locator = {
    first() { return locator; },
    async waitFor() {},
    async isEnabled() { return true; },
    async click(options) {
      calls.push(options.trial ? "trial" : "pointer");
      if (options.trial && trialFails) throw new Error("element is covered");
      if (!options.trial && clickFails) throw new Error("pointer click failed midway");
    },
    async evaluate() { calls.push("dom"); },
  };
  return { calls, page: { locator: () => locator } };
}

const covered = fakeClickPage({ trialFails: true });
await activateElement(covered.page, "#a", 1000, undefined, "auto");
assert.deepEqual(covered.calls, ["trial", "dom"], "a failed trial falls back to one DOM click");

const pointerOk = fakeClickPage({});
await activateElement(pointerOk.page, "#a", 1000, undefined, "auto");
assert.deepEqual(pointerOk.calls, ["trial", "pointer"]);

const midway = fakeClickPage({ clickFails: true });
await assert.rejects(activateElement(midway.page, "#a", 1000, undefined, "auto"), /pointer click failed midway/);
assert.deepEqual(midway.calls, ["trial", "pointer"], "no DOM click after a pointer click that may have landed");

const domDefault = fakeClickPage({});
await activateElement(domDefault.page, "#a", 1000);
assert.deepEqual(domDefault.calls, ["dom"], "the default mode stays a DOM click");

// --- Humanized drag / clickAt -------------------------------------------------
import { buildDragPath, humanizedClickAt, humanizedDrag, DRAG_HOLD_MAX_MS, DRAG_HOLD_MIN_MS, DRAG_JITTER_PX, DRAG_MAX_ARC_PX, DRAG_MAX_DURATION_MS, DRAG_MAX_MOVES, DRAG_MIN_DURATION_MS, DRAG_MIN_MOVES, DRAG_OVERSHOOT_MAX_PX, DRAG_OVERSHOOT_MIN_PX } from "../dist/pointer.js";
import { runSequenceAction } from "../dist/sequence.js";
import { sequenceActionSchema } from "../dist/schema/tools.js";

// Schema: drag needs exactly one of selector/from, and a destination.
assert.equal(sequenceActionSchema.safeParse({ type: "drag" }).success, false);
assert.equal(sequenceActionSchema.safeParse({ type: "drag", selector: "#a", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }).success, false);
assert.equal(sequenceActionSchema.safeParse({ type: "drag", from: { x: 1, y: 2 } }).success, false, "coordinate drag requires 'to'");
assert.equal(sequenceActionSchema.safeParse({ type: "drag", selector: "#a" }).success, false, "selector drag requires a destination");
assert.equal(sequenceActionSchema.safeParse({ type: "drag", selector: "#a", deltaX: 100 }).success, true);
assert.equal(sequenceActionSchema.safeParse({ type: "drag", selector: "#a", targetSelector: "#b" }).success, true);
assert.equal(sequenceActionSchema.safeParse({ type: "drag", from: { x: 1, y: 2 }, to: { x: 30, y: 40 } }).success, true);
assert.equal(sequenceActionSchema.safeParse({ type: "clickAt", x: 10, y: 20 }).success, true);
assert.equal(sequenceActionSchema.safeParse({ type: "clickAt", x: 10 }).success, false);

// With a constant rand the path is deterministic: rand 0.5 gives 60 moves,
// 1150 ms, zero arc and zero jitter, so every point lies exactly on the line
// and the delays sum to the duration.
const mid = () => 0.5;
const path = buildDragPath({ x: 0, y: 0 }, { x: 300, y: 90 }, mid);
assert.equal(path.points.length, 60, "rand 0.5 selects the middle of the 40-80 move range");
assert.equal(path.durationMs, 1150, "rand 0.5 selects the middle of the 800-1500 ms range");
assert.ok(path.durationMs >= DRAG_MIN_DURATION_MS && path.durationMs <= DRAG_MAX_DURATION_MS);
assert.deepEqual(path.points[path.points.length - 1], { x: 300, y: 90, delayMs: path.points[path.points.length - 1].delayMs }, "the last point is exactly the target");
let delaySum = 0;
for (const point of path.points) {
  assert.ok(point.delayMs >= 0, "eased timeline keeps delays non-negative");
  delaySum += point.delayMs;
  assert.ok(Math.abs(point.y - point.x * 0.3) < 1e-9, `point on the drag line: ${JSON.stringify(point)}`);
}
assert.ok(Math.abs(delaySum - 1150) < 1e-9, "delays sum to the total duration");

// With a random source the bounds still hold and intermediate points stay
// within jitter + arc of the drag line.
for (let trial = 0; trial < 20; trial += 1) {
  const randomPath = buildDragPath({ x: 10, y: 20 }, { x: 310, y: 110 });
  assert.ok(randomPath.points.length >= DRAG_MIN_MOVES && randomPath.points.length <= DRAG_MAX_MOVES);
  assert.ok(randomPath.durationMs >= DRAG_MIN_DURATION_MS && randomPath.durationMs <= DRAG_MAX_DURATION_MS);
  const last = randomPath.points[randomPath.points.length - 1];
  assert.equal(last.x, 310);
  assert.equal(last.y, 110, "the drag always ends exactly on the target");
  for (const point of randomPath.points.slice(0, -1)) {
    // Perpendicular distance from the segment, bounded by jitter + arc.
    const dx = 300;
    const dy = 90;
    const cross = Math.abs(dy * (point.x - 10) - dx * (point.y - 20)) / Math.hypot(dx, dy);
    assert.ok(cross <= DRAG_JITTER_PX + DRAG_MAX_ARC_PX + 1e-9, `jitter/arc bounded: ${cross}`);
  }
}

function fakeMouse() {
  const calls = [];
  return {
    calls,
    async move(x, y) { calls.push(["move", x, y]); },
    async down() { calls.push(["down"]); },
    async up() { calls.push(["up"]); },
  };
}

function fakeSleep() {
  const sleeps = [];
  return { sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}

// A full drag: move to start, down, 200 ms hold (rand 0.5), 60 path moves,
// 4 px overshoot along the drag direction, correction back to the target, up.
const dragMouse = fakeMouse();
const dragSleep = fakeSleep();
await humanizedDrag(dragMouse, { x: 0, y: 0 }, { x: 300, y: 90 }, 60000, { sleep: dragSleep.sleep, rand: mid });
assert.deepEqual(dragMouse.calls[0], ["move", 0, 0]);
assert.deepEqual(dragMouse.calls[1], ["down"]);
assert.deepEqual(dragMouse.calls[dragMouse.calls.length - 1], ["up"]);
assert.equal(dragMouse.calls.filter((c) => c[0] === "move").length, 1 + 60 + 2, "start + path + overshoot + correction");
assert.equal(dragSleep.sleeps[0], DRAG_HOLD_MIN_MS + Math.floor(0.5 * (DRAG_HOLD_MAX_MS - DRAG_HOLD_MIN_MS + 1)), "hold after pointerdown within 100-300 ms");
const correction = dragMouse.calls[dragMouse.calls.length - 2];
assert.deepEqual(correction, ["move", 300, 90], "correction returns to the target before pointerup");
const overshootMove = dragMouse.calls[dragMouse.calls.length - 3];
const overshootDistance = Math.hypot(overshootMove[1] - 300, overshootMove[2] - 90);
assert.ok(overshootDistance >= DRAG_OVERSHOOT_MIN_PX - 1e-9 && overshootDistance <= DRAG_OVERSHOOT_MAX_PX + 1e-9, `overshoot within 3-5 px: ${overshootDistance}`);
// The overshoot continues along the drag direction (unit vector (300, 90)/dist).
const dist = Math.hypot(300, 90);
assert.ok(Math.abs((overshootMove[1] - 300) / overshootDistance - 300 / dist) < 1e-9);
assert.ok(Math.abs((overshootMove[2] - 90) / overshootDistance - 90 / dist) < 1e-9);
const totalSleep = dragSleep.sleeps.reduce((a, b) => a + b, 0);
assert.ok(totalSleep >= DRAG_MIN_DURATION_MS + DRAG_HOLD_MIN_MS && totalSleep <= DRAG_MAX_DURATION_MS + DRAG_HOLD_MAX_MS + 160, `gesture timing bounded: ${totalSleep}`);

// clickAt lands pointerdown exactly on (x, y) after the jitter, holds
// 100-300 ms, then pointerup.
const clickMouse = fakeMouse();
const clickSleep = fakeSleep();
await humanizedClickAt(clickMouse, 50, 60, 60000, { sleep: clickSleep.sleep, rand: mid });
const downIndex = clickMouse.calls.findIndex((c) => c[0] === "down");
assert.deepEqual(clickMouse.calls[downIndex - 1], ["move", 50, 60], "pointerdown lands exactly on the requested coordinate");
assert.deepEqual(clickMouse.calls[clickMouse.calls.length - 1], ["up"]);
const holdSleep = clickSleep.sleeps[clickSleep.sleeps.length - 1];
assert.ok(holdSleep >= DRAG_HOLD_MIN_MS && holdSleep <= DRAG_HOLD_MAX_MS, `hold between down and up: ${holdSleep}`);

// A hung pointer move is bounded by the action timeout, like other actions.
const hungMouse = { move: () => new Promise(() => {}), async down() {}, async up() {} };
await assert.rejects(humanizedDrag(hungMouse, { x: 0, y: 0 }, { x: 10, y: 10 }, 50), (error) => {
  assert.ok(isOperationTimeout(error), "drag timeout is a local OperationTimeoutError");
  assert.match(error.message, /Drag action timed out\./);
  return true;
});
await assert.rejects(humanizedClickAt(hungMouse, 5, 5, 50), /ClickAt action timed out\./);

// runSequenceAction drives both new actions through page.mouse.
const actionMouse = fakeMouse();
const clickResult = await runSequenceAction({ mouse: actionMouse }, { type: "clickAt", x: 50, y: 60, timeout: 5000 }, 0, [], []);
assert.equal(clickResult.status, "ok");
assert.equal(clickResult.type, "clickAt");
const clickDown = actionMouse.calls.findIndex((c) => c[0] === "down");
assert.deepEqual(actionMouse.calls[clickDown - 1], ["move", 50, 60]);
assert.deepEqual(actionMouse.calls[actionMouse.calls.length - 1], ["up"]);

const coordDragMouse = fakeMouse();
const coordResult = await runSequenceAction({ mouse: coordDragMouse }, { type: "drag", from: { x: 10, y: 10 }, to: { x: 160, y: 60 }, timeout: 8000 }, 0, [], []);
assert.equal(coordResult.status, "ok");
assert.equal(coordResult.type, "drag");
const coordMoves = coordDragMouse.calls.filter((c) => c[0] === "move");
assert.ok(coordMoves.length >= 1 + DRAG_MIN_MOVES + 2 && coordMoves.length <= 1 + DRAG_MAX_MOVES + 2, `drag emits 40-80 path moves: ${coordMoves.length}`);
assert.deepEqual(coordDragMouse.calls[0], ["move", 10, 10]);
assert.deepEqual(coordDragMouse.calls[coordDragMouse.calls.length - 2], ["move", 160, 60], "drag corrects back to 'to' before pointerup");

// Selector-based drag resolves the element center and applies the delta.
const selectorLocator = {
  first() { return selectorLocator; },
  async waitFor() {},
  async boundingBox() { return { x: 10, y: 10, width: 40, height: 20 }; },
};
const selectorPage = { locator: () => selectorLocator, mouse: fakeMouse() };
const selectorResult = await runSequenceAction(selectorPage, { type: "drag", selector: "#handle", deltaX: 100, timeout: 8000 }, 0, [], []);
assert.equal(selectorResult.status, "ok");
assert.equal(selectorResult.selector, "#handle");
assert.deepEqual(selectorPage.mouse.calls[0], ["move", 30, 20], "drag starts at the element center");
assert.deepEqual(selectorPage.mouse.calls[selectorPage.mouse.calls.length - 2], ["move", 130, 20], "delta drag ends at center + delta");

console.log("Sequence unit tests passed.");
