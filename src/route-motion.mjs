const METERS_PER_LATITUDE_DEGREE = 111_320;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function parseLineString(wkt) {
  const match = /^LINESTRING\s*\((.*)\)$/i.exec(String(wkt || '').trim());
  if (!match) return null;
  const coordinates = match[1].split(',').map(pair => pair.trim().split(/\s+/).map(Number));
  if (coordinates.length < 2 || coordinates.some(pair => pair.length < 2 || !pair.slice(0, 2).every(Number.isFinite))) return null;
  return coordinates;
}

function distanceMeters(a, b, latitude) {
  const x = (b[0] - a[0]) * METERS_PER_LATITUDE_DEGREE * Math.cos(latitude * Math.PI / 180);
  const y = (b[1] - a[1]) * METERS_PER_LATITUDE_DEGREE;
  return Math.hypot(x, y);
}

function makeTrack(row) {
  const coordinates = parseLineString(row.wkt);
  if (!coordinates) return null;
  const longitude = new Float64Array(coordinates.length);
  const latitude = new Float64Array(coordinates.length);
  const cumulative = new Float64Array(coordinates.length);
  for (let index = 0; index < coordinates.length; index += 1) {
    longitude[index] = coordinates[index][0];
    latitude[index] = coordinates[index][1];
    if (index) cumulative[index] = cumulative[index - 1] + distanceMeters(coordinates[index - 1], coordinates[index], latitude[index]);
  }
  return {
    longitude,
    latitude,
    cumulative,
    length: cumulative.at(-1),
    isLoop: distanceMeters(coordinates[0], coordinates.at(-1), latitude[0]) < 250,
  };
}

export function buildShapeIndex(rows = []) {
  const index = new Map();
  for (const row of rows) {
    const direction = Number(row?.GoBack);
    if ((direction !== 0 && direction !== 1) || row?.RouteID == null) continue;
    const track = makeTrack(row);
    if (!track) continue;
    const key = Number(row.SubRouteID) === -1
      ? `main:${row.RouteID}:${direction}`
      : `sub:${row.SubRouteID}:${direction}`;
    track.key = key;
    index.set(key, track);
  }
  return index;
}

function angularDifference(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function segmentBearing(track, index) {
  const latitude = (track.latitude[index] + track.latitude[index + 1]) / 2;
  const x = (track.longitude[index + 1] - track.longitude[index]) * Math.cos(latitude * Math.PI / 180);
  const y = track.latitude[index + 1] - track.latitude[index];
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}

function progressDistance(track, first, second) {
  const direct = Math.abs(first - second);
  return track.isLoop ? Math.min(direct, Math.max(0, track.length - direct)) : direct;
}

function nearestProgress(track, bus, { expectedProgress = null } = {}) {
  const cosine = Math.cos(Number(bus.lat) * Math.PI / 180);
  let best = null;
  for (let index = 0; index < track.longitude.length - 1; index += 1) {
    const ax = (track.longitude[index] - bus.lon) * METERS_PER_LATITUDE_DEGREE * cosine;
    const ay = (track.latitude[index] - bus.lat) * METERS_PER_LATITUDE_DEGREE;
    const bx = (track.longitude[index + 1] - bus.lon) * METERS_PER_LATITUDE_DEGREE * cosine;
    const by = (track.latitude[index + 1] - bus.lat) * METERS_PER_LATITUDE_DEGREE;
    const dx = bx - ax;
    const dy = by - ay;
    const denominator = dx * dx + dy * dy;
    const fraction = denominator ? clamp(-(ax * dx + ay * dy) / denominator, 0, 1) : 0;
    const x = ax + dx * fraction;
    const y = ay + dy * fraction;
    const distance = Math.hypot(x, y);
    const bearing = segmentBearing(track, index);
    // Location dominates. Heading only resolves loops and parallel stretches
    // where nearest-point matching is otherwise ambiguous.
    const headingPenalty = Number(bus.speed) >= 3 && Number.isFinite(Number(bus.bearing))
      ? angularDifference(bearing, Number(bus.bearing)) / 180 * 25
      : 0;
    const segmentLength = track.cumulative[index + 1] - track.cumulative[index];
    const progress = track.cumulative[index] + segmentLength * fraction;
    const continuityDistance = Number.isFinite(expectedProgress)
      ? progressDistance(track, progress, expectedProgress)
      : 0;
    // Continuity is deliberately capped. It resolves equal-distance candidates
    // on loops and overlapping roads without overriding a clearly better GPS fix.
    const continuityPenalty = Math.min(40, continuityDistance * 0.15);
    const score = distance * distance + headingPenalty * headingPenalty + continuityPenalty * continuityPenalty;
    if (!best || score < best.score) {
      best = { score, distance, progress, continuityDistance };
    }
  }
  return best;
}

function pointAtProgress(track, progress) {
  const target = clamp(progress, 0, track.length);
  let low = 0;
  let high = track.cumulative.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (track.cumulative[middle] <= target) low = middle;
    else high = middle;
  }
  const length = track.cumulative[high] - track.cumulative[low];
  const fraction = length ? (target - track.cumulative[low]) / length : 0;
  return {
    lon: track.longitude[low] + (track.longitude[high] - track.longitude[low]) * fraction,
    lat: track.latitude[low] + (track.latitude[high] - track.latitude[low]) * fraction,
    bearing: segmentBearing(track, low),
    routeKey: track.key,
    routeProgress: target,
    routeLength: track.length,
  };
}

export function createRouteMotionModel(bus, shapeIndex, {
  maximumSnapMeters = 120,
  previousModel = null,
  positionGain = 0.55,
  velocityGain = 0.12,
} = {}) {
  if (!bus || (bus.direction !== 0 && bus.direction !== 1)) return null;
  const track = shapeIndex.get(`sub:${bus.routeId}:${bus.direction}`) ||
    shapeIndex.get(`main:${bus.shapeRouteId}:${bus.direction}`);
  if (!track) return null;
  const reportedAtMs = Date.parse(bus.updatedAt);
  if (previousModel?.track === track && reportedAtMs <= previousModel.reportedAtMs) return previousModel;
  const sameTrack = previousModel?.track === track;
  const elapsedSec = sameTrack && Number.isFinite(reportedAtMs) && Number.isFinite(previousModel.reportedAtMs)
    ? (reportedAtMs - previousModel.reportedAtMs) / 1000
    : null;
  const expectedProgress = elapsedSec > 0
    ? Math.min(track.length, previousModel.progress + previousModel.speedMps * elapsedSec)
    : null;
  const match = nearestProgress(track, bus, { expectedProgress });
  if (!match || match.distance > maximumSnapMeters) return null;
  let progress = match.progress;
  let speedMps = clamp(Number(bus.speed) || 0, 0, 80) / 3.6;
  let innovationRatio = 0;

  if (sameTrack) {
    const wrappedAtTerminus = previousModel.progress > track.length * 0.85 && match.progress < track.length * 0.15;
    if (elapsedSec > 0 && !wrappedAtTerminus) {
      const predictedProgress = expectedProgress;
      // A bad match on a parallel or overlapping section can be kilometres
      // away along the same shape. Limit one observation's influence to a
      // physically plausible distance before applying the α-β correction.
      const maximumInnovation = Math.max(120, elapsedSec * 25 + 60);
      const rawInnovation = match.progress - predictedProgress;
      innovationRatio = Math.min(1, Math.abs(rawInnovation) / maximumInnovation);
      const innovation = clamp(rawInnovation, -maximumInnovation, maximumInnovation);
      progress = Math.max(previousModel.progress, predictedProgress + positionGain * innovation);

      const routeVelocity = previousModel.speedMps + velocityGain * innovation / elapsedSec;
      const desiredSpeed = routeVelocity * 0.7 + speedMps * 0.3;
      const maximumSpeedChange = Math.min(4, elapsedSec * 0.8);
      speedMps = clamp(
        previousModel.speedMps + clamp(desiredSpeed - previousModel.speedMps, -maximumSpeedChange, maximumSpeedChange),
        0,
        80 / 3.6,
      );
    }
  }
  const positionConfidence = 1 - clamp(match.distance / maximumSnapMeters, 0, 1);
  const confidence = clamp(0.15 + positionConfidence * 0.7 + (1 - innovationRatio) * 0.15, 0.1, 1);
  return {
    track,
    progress,
    reportedAtMs,
    speedMps,
    snapDistanceMeters: match.distance,
    confidence,
  };
}

export function predictOnRoute(model, atMs, {
  minimumSpeedKph = 3,
  maximumExtrapolationSec = 15,
  maximumDistanceMeters = 250,
} = {}) {
  if (!model || !Number.isFinite(model.reportedAtMs)) return null;
  const confidence = clamp(Number(model.confidence) || 0.5, 0.25, 1);
  const confidenceWindowSec = Math.max(4, maximumExtrapolationSec * confidence);
  const elapsedSec = clamp((atMs - model.reportedAtMs) / 1000, 0, confidenceWindowSec);
  const distance = model.speedMps * 3.6 < minimumSpeedKph
    ? 0
    : Math.min(model.speedMps * elapsedSec, maximumDistanceMeters);
  return pointAtProgress(model.track, model.progress + distance);
}

export function applyRouteMotion(buses, models, atMs) {
  return buses.map(bus => {
    const model = models.get(bus.id);
    const point = predictOnRoute(model, atMs);
    return point ? {
      ...bus,
      ...point,
      estimatedAt: new Date(atMs).toISOString(),
      motionMode: 'route',
      motionSpeedKph: model.speedMps * 3.6,
      motionConfidence: Math.round(model.confidence * 100),
    } : bus;
  });
}
