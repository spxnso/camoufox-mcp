import assert from "node:assert/strict";
import { captureScreenshot, fullPageClip, isScreenshotAreaAllowed, visibleElementClip } from "../dist/screenshots.js";
import { MAX_FULL_PAGE_SCREENSHOT_HEIGHT, MAX_SCREENSHOT_HEIGHT, MAX_SCREENSHOT_WIDTH } from "../dist/config.js";

// --- Full-page limits -------------------------------------------------------
// A full page is taller than one viewport by design. It used to be held to the
// viewport height limit, which rejected nearly every real page.
assert.deepEqual(fullPageClip(1280, 3000), { width: 1280, height: 3000, clipped: false });
assert.deepEqual(fullPageClip(1280, MAX_FULL_PAGE_SCREENSHOT_HEIGHT + 500), { width: 1280, height: MAX_FULL_PAGE_SCREENSHOT_HEIGHT, clipped: true });
assert.deepEqual(fullPageClip(MAX_SCREENSHOT_WIDTH + 400, 900), { width: MAX_SCREENSHOT_WIDTH, height: 900, clipped: true });
assert.equal(fullPageClip(0, 900), undefined);
assert.equal(fullPageClip(Number.NaN, 900), undefined);

// Element captures keep the viewport-sized policy.
assert.equal(isScreenshotAreaAllowed(MAX_SCREENSHOT_WIDTH, MAX_SCREENSHOT_HEIGHT), true);
assert.equal(isScreenshotAreaAllowed(MAX_SCREENSHOT_WIDTH, MAX_SCREENSHOT_HEIGHT + 1), false);

// --- Element clip -----------------------------------------------------------
// An element hanging off the left edge: the old code moved x to 0 but kept the
// full width, so the capture slid right by the hidden amount.
assert.deepEqual(
  visibleElementClip({ x: -40, y: 10, width: 200, height: 50 }, { width: 800, height: 600 }),
  { x: 0, y: 10, width: 160, height: 50 },
);
assert.deepEqual(
  visibleElementClip({ x: 700, y: 580, width: 200, height: 50 }, { width: 800, height: 600 }),
  { x: 700, y: 580, width: 100, height: 20 },
);
assert.deepEqual(
  visibleElementClip({ x: 900, y: 10, width: 50, height: 50 }, { width: 800, height: 600 }),
  { x: 900, y: 10, width: 0, height: 50 },
  "an element entirely outside the viewport has no visible area",
);
assert.deepEqual(
  visibleElementClip({ x: -10, y: -10, width: 100, height: 100 }, null),
  { x: 0, y: 0, width: 90, height: 90 },
);

// --- captureScreenshot with a fake page --------------------------------------
function fakePage(pageSize) {
  const calls = [];
  return {
    calls,
    async evaluate() { return pageSize; },
    async screenshot(options) { calls.push(options); return Buffer.from("png-bytes"); },
  };
}

const ordinary = fakePage({ width: 1280, height: 3000 });
const ordinaryResult = await captureScreenshot(ordinary, "https://example.com/", { fullPage: true });
assert.equal(ordinaryResult.screenshotMetadata.included, true);
assert.equal(ordinaryResult.screenshotMetadata.pageHeight, 3000);
assert.equal(ordinaryResult.screenshotMetadata.clipped, undefined);
assert.equal(ordinary.calls[0].fullPage, true);
assert.equal(ordinary.calls[0].clip, undefined, "a page within the limits is captured whole");

const tall = fakePage({ width: 1280, height: MAX_FULL_PAGE_SCREENSHOT_HEIGHT * 3 });
const tallResult = await captureScreenshot(tall, "https://example.com/", { fullPage: true });
assert.equal(tallResult.screenshotMetadata.included, true);
assert.equal(tallResult.screenshotMetadata.clipped, true);
assert.equal(tallResult.screenshotMetadata.pageHeight, MAX_FULL_PAGE_SCREENSHOT_HEIGHT * 3);
assert.deepEqual(tall.calls[0].clip, { x: 0, y: 0, width: 1280, height: MAX_FULL_PAGE_SCREENSHOT_HEIGHT });

const viewportOnly = fakePage({ width: 1280, height: 3000 });
const viewportResult = await captureScreenshot(viewportOnly, "https://example.com/", {});
assert.equal(viewportOnly.calls[0].fullPage, false);
assert.equal(viewportResult.screenshotMetadata.pageHeight, undefined, "page size is reported for full-page captures only");

// --- Caller-supplied clip -----------------------------------------------------
function fakeClippedPage(pageSize, viewport) {
  const calls = [];
  return {
    calls,
    async evaluate() { return pageSize; },
    viewportSize() { return viewport; },
    async screenshot(options) { calls.push(options); return Buffer.from("png-bytes"); },
  };
}

const viewport = { width: 800, height: 600 };

// A clip fully inside the viewport is passed through unchanged and reported.
const inside = fakeClippedPage({ width: 1280, height: 3000 }, viewport);
const insideResult = await captureScreenshot(inside, "https://example.com/", { clip: { x: 10, y: 20, width: 100, height: 80 } });
assert.equal(insideResult.screenshotMetadata.included, true);
assert.deepEqual(inside.calls[0].clip, { x: 10, y: 20, width: 100, height: 80 });
assert.equal(inside.calls[0].fullPage, undefined, "a clip capture is a viewport capture");
assert.deepEqual(insideResult.screenshotMetadata.clip, { x: 10, y: 20, width: 100, height: 80 });
assert.equal(insideResult.screenshotMetadata.clipped, undefined);

// A clip hanging off the bottom right is intersected with the viewport; the
// size shrinks (not just the origin) so the capture stays on the region.
const overhang = fakeClippedPage({ width: 1280, height: 3000 }, viewport);
const overhangResult = await captureScreenshot(overhang, "https://example.com/", { clip: { x: 700, y: 550, width: 200, height: 100 } });
assert.equal(overhangResult.screenshotMetadata.included, true);
assert.deepEqual(overhang.calls[0].clip, { x: 700, y: 550, width: 100, height: 50 });
assert.deepEqual(overhangResult.screenshotMetadata.clip, { x: 700, y: 550, width: 100, height: 50 });
assert.equal(overhangResult.screenshotMetadata.clipped, true, "a clamped clip is reported");

// A negative origin is clamped and the size shrinks by the hidden amount.
const negative = fakeClippedPage({ width: 1280, height: 3000 }, viewport);
const negativeResult = await captureScreenshot(negative, "https://example.com/", { clip: { x: -10, y: -5, width: 100, height: 100 } });
assert.deepEqual(negative.calls[0].clip, { x: 0, y: 0, width: 90, height: 95 });
assert.equal(negativeResult.screenshotMetadata.clipped, true);

// Without a fixed viewport only the origin is bounded.
const noViewport = fakeClippedPage({ width: 1280, height: 3000 }, null);
const noViewportResult = await captureScreenshot(noViewport, "https://example.com/", { clip: { x: -10, y: 0, width: 100, height: 50 } });
assert.deepEqual(noViewport.calls[0].clip, { x: 0, y: 0, width: 90, height: 50 }, "the hidden 10 px shrinks the width even without a fixed viewport");
assert.equal(noViewportResult.screenshotMetadata.clipped, true);

// A clip entirely outside the viewport has no visible area.
const outside = fakeClippedPage({ width: 1280, height: 3000 }, viewport);
const outsideResult = await captureScreenshot(outside, "https://example.com/", { clip: { x: 900, y: 10, width: 50, height: 50 } });
assert.equal(outsideResult.screenshotMetadata.included, false);
assert.match(outsideResult.screenshotMetadata.error, /no visible area/);
assert.equal(outside.calls.length, 0, "no capture is attempted");

// The dimension policy applies to the requested size, not the clamped one.
const oversize = fakeClippedPage({ width: 1280, height: 3000 }, viewport);
const oversizeResult = await captureScreenshot(oversize, "https://example.com/", { clip: { x: 0, y: 0, width: MAX_SCREENSHOT_WIDTH + 1, height: 100 } });
assert.equal(oversizeResult.screenshotMetadata.included, false);
assert.match(oversizeResult.screenshotMetadata.error, /dimension policy/);
assert.equal(oversize.calls.length, 0);

// clip cannot be combined with selector or fullPage.
const withSelector = fakeClippedPage({ width: 1280, height: 3000 }, viewport);
const selectorResult = await captureScreenshot(withSelector, "https://example.com/", { selector: "#a", clip: { x: 0, y: 0, width: 10, height: 10 } });
assert.equal(selectorResult.screenshotMetadata.included, false);
assert.match(selectorResult.screenshotMetadata.error, /cannot be combined with a selector/);
assert.equal(withSelector.calls.length, 0);

const withFullPage = fakeClippedPage({ width: 1280, height: 3000 }, viewport);
const fullPageResult = await captureScreenshot(withFullPage, "https://example.com/", { fullPage: true, clip: { x: 0, y: 0, width: 10, height: 10 } });
assert.equal(fullPageResult.screenshotMetadata.included, false);
assert.match(fullPageResult.screenshotMetadata.error, /cannot be combined with fullPage/);
assert.equal(withFullPage.calls.length, 0);

console.log("Screenshot unit tests passed.");
