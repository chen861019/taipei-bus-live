const EARTH_RADIUS_METERS = 6_371_008.8;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function predictBusCoordinate(bus, atMs, {
  minimumSpeedKph = 3,
  maximumSpeedKph = 80,
  maximumExtrapolationSec = 15,
  maximumDistanceMeters = 250,
} = {}) {
  const base = [Number(bus.lon), Number(bus.lat)];
  const updatedMs = Date.parse(bus.estimatedAt || bus.updatedAt);
  const speedKph = Number(bus.motionSpeedKph ?? bus.speed);
  const bearingDegrees = Number(bus.bearing);
  if (!base.every(Number.isFinite) || !Number.isFinite(updatedMs) ||
      !Number.isFinite(speedKph) || speedKph < minimumSpeedKph ||
      !Number.isFinite(bearingDegrees)) return base;

  const elapsedSec = clamp((atMs - updatedMs) / 1000, 0, maximumExtrapolationSec);
  const distanceMeters = Math.min(
    clamp(speedKph, 0, maximumSpeedKph) / 3.6 * elapsedSec,
    maximumDistanceMeters,
  );
  if (distanceMeters <= 0) return base;

  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const bearing = bearingDegrees * Math.PI / 180;
  const latitude = base[1] * Math.PI / 180;
  const longitude = base[0] * Math.PI / 180;
  const targetLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
    Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const targetLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(targetLatitude),
  );
  return [targetLongitude * 180 / Math.PI, targetLatitude * 180 / Math.PI];
}

export function followCoordinate(current, target, { maximumStepMeters = Infinity } = {}) {
  if (!current?.every(Number.isFinite)) return [...target];
  // Retarget from the current position on every tick, so a new GPS fix can
  // interrupt an in-progress correction without restarting from the old fix.
  const latitude = (current[1] + target[1]) / 2 * Math.PI / 180;
  const xMeters = (target[0] - current[0]) * 111_320 * Math.cos(latitude);
  const yMeters = (target[1] - current[1]) * 111_320;
  const distanceMeters = Math.hypot(xMeters, yMeters);
  const fraction = distanceMeters
    ? Math.min(0.5, Math.max(0, maximumStepMeters) / distanceMeters)
    : 0;
  return [
    current[0] + (target[0] - current[0]) * fraction,
    current[1] + (target[1] - current[1]) * fraction,
  ];
}

export function stabilizeRouteTarget(previous, next) {
  if (!previous || !next || !previous.routeKey || previous.routeKey !== next.routeKey ||
      !Number.isFinite(previous.routeProgress) || !Number.isFinite(next.routeProgress)) return next;
  if (next.routeProgress >= previous.routeProgress) return next;
  const length = Number(next.routeLength) || Number(previous.routeLength);
  const wrappedAtTerminus = Number.isFinite(length) && length > 0 &&
    previous.routeProgress > length * 0.85 && next.routeProgress < length * 0.15;
  if (wrappedAtTerminus) return next;
  return {
    ...next,
    lon: previous.lon,
    lat: previous.lat,
    bearing: previous.bearing,
    routeProgress: previous.routeProgress,
  };
}
