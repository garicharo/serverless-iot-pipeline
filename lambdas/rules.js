/**
 * One reading identity. The hardware could not emit two different
 * measurements for the same device in the same millisecond.
 */
function readingKey(deviceId, timestampMs) {
  if (!deviceId || timestampMs === undefined || timestampMs === null || timestampMs === "") {
    throw new Error("deviceId and timestampMs are required");
  }
  return `${deviceId}#${timestampMs}`;
}

const SILENCE_HOURS = [3, 6, 12, 24];

function silenceHours(nowMs, lastSeenMs) {
  if (lastSeenMs === undefined || lastSeenMs === null) {
    return null;
  }
  const silentMs = nowMs - Number(lastSeenMs);
  let hit = null;
  for (const hours of SILENCE_HOURS) {
    if (silentMs >= hours * 60 * 60 * 1000) {
      hit = hours;
    }
  }
  return hit;
}

/**
 * Cumulative points are ordered by timestamp, not by arrival.
 * A late older point is inserted among the last five and flagged.
 * The delta is the difference between neighbors. Both values are kept:
 * cumulative is what the meter said, delta is the consumption of that slice.
 * A smaller value is not treated as consumption going backwards until the
 * timestamp says where it sits. A newer smaller value can be a meter reset;
 * that rule is not in this function.
 */
function placeCumulative(window, reading) {
  const held = window
    .slice()
    .sort((left, right) => left.timestampMs - right.timestampMs);
  if (held.length === 5 && reading.timestampMs < held[0].timestampMs) {
    return { window: held, deltas: deltasOf(held), placed: false };
  }
  const late = held.some((point) => point.timestampMs > reading.timestampMs);
  const next = held.concat([{
    timestampMs: reading.timestampMs,
    cumulative: reading.cumulative,
    flagged: late,
  }]);
  next.sort((left, right) => left.timestampMs - right.timestampMs);
  const kept = next.slice(-5);
  return { window: kept, deltas: deltasOf(kept), placed: true };
}

function deltasOf(points) {
  const deltas = [];
  for (let index = 1; index < points.length; index += 1) {
    deltas.push({
      from: points[index - 1].timestampMs,
      to: points[index].timestampMs,
      delta: points[index].cumulative - points[index - 1].cumulative,
    });
  }
  return deltas;
}

/** An interval reading is already the slice. There is nothing to subtract. */
function placeInterval(reading) {
  return { delta: reading.value, cumulative: null };
}

module.exports = {
  readingKey,
  silenceHours,
  SILENCE_HOURS,
  placeCumulative,
  placeInterval,
};
