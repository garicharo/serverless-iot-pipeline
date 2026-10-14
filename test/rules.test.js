const test = require("node:test");
const assert = require("node:assert/strict");
const { readingKey, silenceHours, placeCumulative, placeInterval } = require("../lambdas/rules");

test("the same device and millisecond is one key", () => {
  assert.equal(readingKey("meter-1", 1710000000123), "meter-1#1710000000123");
});

test("silence steps at 3, 6, 12 and 24 hours", () => {
  const hour = 60 * 60 * 1000;
  const seen = 1_000_000;
  assert.equal(silenceHours(seen + 2 * hour, seen), null);
  assert.equal(silenceHours(seen + 3 * hour, seen), 3);
  assert.equal(silenceHours(seen + 25 * hour, seen), 24);
});

test("an in-order cumulative stores the meter value and the slice", () => {
  const first = placeCumulative([], { timestampMs: 400, cumulative: 500 });
  const second = placeCumulative(first.window, { timestampMs: 410, cumulative: 600 });
  assert.equal(second.deltas[0].delta, 100);
  assert.equal(second.window[1].flagged, false);
  assert.equal(second.window[1].cumulative, 600);
});

test("a late older cumulative is inserted and flagged, not treated as backwards consumption", () => {
  const newer = placeCumulative([], { timestampMs: 410, cumulative: 600 });
  const older = placeCumulative(newer.window, { timestampMs: 400, cumulative: 500 });
  assert.equal(older.placed, true);
  assert.equal(older.window[0].flagged, true);
  assert.equal(older.deltas[0].delta, 100);
});

test("an interval reading is the slice itself", () => {
  assert.deepEqual(placeInterval({ value: 100 }), { delta: 100, cumulative: null });
});
