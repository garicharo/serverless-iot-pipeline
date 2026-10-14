const { placeCumulative, placeInterval } = require("./rules");

exports.handler = async (event) => {
  const kind = (event.payload && event.payload.kind) || (event.config && event.config.kind) || "cumulative";
  if (kind === "interval") {
    const placed = placeInterval({ value: event.payload.value });
    return { ...event, kind, delta: placed.delta };
  }
  const placed = placeCumulative(event.window || [], {
    timestampMs: event.timestampMs,
    cumulative: event.payload.cumulative,
  });
  const last = placed.deltas[placed.deltas.length - 1];
  return { ...event, kind, placed, delta: last ? last.delta : null };
};
