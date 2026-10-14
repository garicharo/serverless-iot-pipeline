/**
 * Dedup identity. Each device that sends measurements has its own id.
 * API Gateway uses that id plus the request id.
 * A door without a request id uses that id plus the timestamp.
 * The hardware could not emit two different measurements for the same
 * device in the same millisecond, so the timestamp is enough on that door.
 */
function readingKey(deviceId, sourceId) {
  if (!deviceId || sourceId === undefined || sourceId === null || sourceId === "") {
    throw new Error("deviceId and a request id or timestamp are required");
  }
  return `${deviceId}#${sourceId}`;
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

const GROUP_LEVELS = ["country", "region", "plant", "line", "shift", "machine"];

function groupKey(level, id) {
  if (!GROUP_LEVELS.includes(level) || id === undefined || id === null || id === "") {
    throw new Error("level and id are required");
  }
  return `${level}#${id}`;
}

function dayFromTimestamp(timestampMs) {
  const day = new Date(Number(timestampMs)).toISOString().slice(0, 10);
  if (day === "Invalid Date") {
    throw new Error("timestampMs is required");
  }
  return day;
}

function payloadOf(event) {
  if (event && event.body) {
    return typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  }
  return event || {};
}

/**
 * API Gateway identifies the call with its request id.
 * MQTT and the schedule have no request id, so the timestamp is the other half.
 * The measurement timestamp is always required.
 */
function dedupParts(event) {
  const payload = payloadOf(event);
  const deviceId = payload.deviceId;
  const fromGateway = Boolean(
    event && event.requestContext && event.requestContext.apiId && event.requestContext.requestId
  );
  const sourceId = fromGateway ? event.requestContext.requestId : payload.timestampMs;
  if (!deviceId || sourceId === undefined || sourceId === null || sourceId === "") {
    throw new Error("deviceId and a request id or timestamp are required");
  }
  if (payload.timestampMs === undefined || payload.timestampMs === null || payload.timestampMs === "") {
    throw new Error("timestampMs is required");
  }
  return { deviceId, sourceId, timestampMs: payload.timestampMs, payload, fromGateway };
}

function readingsFromPartner(body) {
  if (Array.isArray(body)) {
    return body;
  }
  if (body && Array.isArray(body.readings)) {
    return body.readings;
  }
  throw new Error("partner payload is not a list of readings");
}

function assertNoDoubleCount(meters) {
  const scopes = new Set(meters.map((meter) => meter.scope));
  if (scopes.has("plant") && scopes.has("line")) {
    throw new Error("a plant meter is not added on top of its line meters");
  }
}

function sumGroup(meters) {
  assertNoDoubleCount(meters);
  return meters.reduce((total, meter) => total + Number(meter.delta), 0);
}

module.exports = {
  readingKey,
  silenceHours,
  SILENCE_HOURS,
  placeCumulative,
  placeInterval,
  groupKey,
  dayFromTimestamp,
  dedupParts,
  readingsFromPartner,
  assertNoDoubleCount,
  sumGroup,
  GROUP_LEVELS,
};
