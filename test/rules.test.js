const test = require("node:test");
const assert = require("node:assert/strict");
const {
  readingKey,
  silenceHours,
  placeCumulative,
  placeInterval,
  groupKey,
  dayFromTimestamp,
  dedupParts,
  readingsFromPartner,
  sumGroup,
} = require("../lambdas/rules");

test("the same device and request id is one key", () => {
  assert.equal(readingKey("meter-1", "req-9"), "meter-1#req-9");
});

test("a door without a request id uses the device and the timestamp", () => {
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

test("a group key is the hierarchy level and its id", () => {
  assert.equal(groupKey("plant", "p1"), "plant#p1");
  assert.equal(dayFromTimestamp(Date.UTC(2024, 0, 2, 3)), "2024-01-02");
});

test("API Gateway dedups on the request id and other doors on the timestamp", () => {
  const gateway = dedupParts({
    requestContext: { apiId: "abc", requestId: "req-9" },
    body: JSON.stringify({ deviceId: "meter-1", timestampMs: 1710000000123 }),
  });
  assert.equal(gateway.sourceId, "req-9");
  assert.equal(readingKey(gateway.deviceId, gateway.sourceId), "meter-1#req-9");

  const mqtt = dedupParts({ deviceId: "meter-1", timestampMs: 1710000000123 });
  assert.equal(mqtt.sourceId, 1710000000123);
});

test("a partner body is a list of readings", () => {
  assert.equal(readingsFromPartner([{ deviceId: "a" }]).length, 1);
  assert.equal(readingsFromPartner({ readings: [{ deviceId: "a" }] }).length, 1);
});

test("a plant meter is not added on top of the line meters", () => {
  assert.equal(sumGroup([{ scope: "line", delta: 10 }, { scope: "line", delta: 5 }]), 15);
  assert.throws(
    () => sumGroup([{ scope: "plant", delta: 30 }, { scope: "line", delta: 10 }]),
    /not added on top/
  );
});
