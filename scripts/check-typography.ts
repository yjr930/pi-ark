import assert from "node:assert/strict";
import { FONT_LEVELS, MAX_FONT_SCALE, MIN_FONT_SCALE, levelPixels, normalizeFontScale } from "../apps/web/src/typography.ts";
import { DEFAULT_APPEARANCE, normalizeAppearance } from "../apps/web/src/appearance.ts";

assert.deepEqual(FONT_LEVELS.map((level) => [level.id, level.baseSize]), [
  ["micro", 9],
  ["caption", 10],
  ["dense", 11],
  ["ui", 13],
  ["reading", 14],
  ["section", 20],
  ["page", 26],
]);
assert.equal(new Set(FONT_LEVELS.map((level) => level.label)).size, FONT_LEVELS.length);

assert.equal(MIN_FONT_SCALE, 0.9);
assert.equal(MAX_FONT_SCALE, 1.3);
assert.equal(normalizeFontScale(undefined), 1);
assert.equal(normalizeFontScale(null), 1);
assert.equal(normalizeFontScale("1.2"), 1);
assert.equal(normalizeFontScale(Number.NaN), 1);
assert.equal(normalizeFontScale(1), 1);
assert.equal(normalizeFontScale(1.02), 1);
assert.equal(normalizeFontScale(1.15), 1.15);
assert.equal(normalizeFontScale(1.1500000000000001), 1.15);
assert.equal(normalizeFontScale(1.23), 1.25);
assert.equal(normalizeFontScale(0.5), 0.9);
assert.equal(normalizeFontScale(2), 1.3);

const reading = FONT_LEVELS.find((level) => level.id === "reading");
const micro = FONT_LEVELS.find((level) => level.id === "micro");
assert.ok(reading && micro);
assert.equal(levelPixels(reading, 1), 14);
assert.equal(levelPixels(reading, 1.15), 16.1);
assert.equal(levelPixels(FONT_LEVELS.find((level) => level.id === "ui")!, 1.15), 14.95);
assert.equal(levelPixels(FONT_LEVELS.find((level) => level.id === "dense")!, 1.15), 12.65);
assert.equal(levelPixels(reading, 1.3), 18.2);
assert.equal(levelPixels(micro, 0.9), 8.1);

const pickAppearance = (value: ReturnType<typeof normalizeAppearance>) => ({ theme: value.theme, hideReasoning: value.hideReasoning, markdownLineBreaks: value.markdownLineBreaks, fontScale: value.fontScale, showWorkingCount: value.showWorkingCount });
assert.deepEqual(pickAppearance(normalizeAppearance(null)), pickAppearance(DEFAULT_APPEARANCE));
assert.deepEqual(pickAppearance(normalizeAppearance({})), pickAppearance(DEFAULT_APPEARANCE));
assert.deepEqual(pickAppearance(normalizeAppearance({ theme: "paper", hideReasoning: true, markdownLineBreaks: false, fontScale: 1.2 })), { theme: "paper", hideReasoning: true, markdownLineBreaks: false, fontScale: 1.2, showWorkingCount: true });
assert.deepEqual(pickAppearance(normalizeAppearance({ theme: "unknown", hideReasoning: "true", markdownLineBreaks: 0, fontScale: 9 })), { theme: "ark-dark", hideReasoning: false, markdownLineBreaks: true, fontScale: 1.3, showWorkingCount: true });
assert.deepEqual(pickAppearance(normalizeAppearance({ theme: "graphite", hideReasoning: true, markdownLineBreaks: true, fontScale: 0.75 })), { theme: "graphite", hideReasoning: true, markdownLineBreaks: true, fontScale: 0.9, showWorkingCount: true });
assert.equal(normalizeAppearance({ showWorkingCount: false }).showWorkingCount, false);
assert.equal(normalizeAppearance({ showWorkingCount: "false" }).showWorkingCount, true);

console.log("Typography levels, font scale bounds, and appearance normalization check passed.");
