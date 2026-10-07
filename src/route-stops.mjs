const finite = value => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const keyFor = (routeId, direction) => `${routeId}:${direction}`;

export function buildRouteStopIndex(rows = []) {
  const index = new Map();
  for (const row of rows) {
    const routeId = String(row?.routeId ?? '').trim();
    const direction = Number(row?.goBack);
    const sequence = finite(row?.seqNo);
    const lon = finite(row?.showLon) ?? finite(row?.longitude);
    const lat = finite(row?.showLat) ?? finite(row?.latitude);
    const name = String(row?.nameZh || row?.nameEn || '').trim();
    if (!routeId || (direction !== 0 && direction !== 1) || sequence == null ||
        lon == null || lat == null || !name || lat < 21 || lat > 26.5 || lon < 119 || lon > 123) continue;
    const key = keyFor(routeId, direction);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({
      id: String(row.Id ?? `${routeId}-${direction}-${sequence}`),
      name,
      sequence,
      lon,
      lat,
      bearing: String(row.bearing || ''),
      address: String(row.address || ''),
    });
  }
  for (const stops of index.values()) stops.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  return index;
}

export function routeStops(index, routeId, direction) {
  return index.get(keyFor(String(routeId), Number(direction))) || [];
}
