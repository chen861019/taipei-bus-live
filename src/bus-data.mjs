import { gunzipSync } from 'node:zlib';

export const VEHICLE_URL = 'https://tcgbusfs.blob.core.windows.net/blobbus/GetBusData.gz';
export const ROUTE_URL = 'https://tcgbusfs.blob.core.windows.net/blobbus/GetRoute.gz';
export const SHAPE_URL = 'https://tcgbusfs.blob.core.windows.net/blobbus/GetBusShape.gz';
export const DATA_ATTRIBUTION = '臺北市政府交通局公共運輸處「臺北市公車動態資訊」';

const finite = value => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function taipeiTimeMs(value) {
  const text = String(value || '').trim();
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (match) return Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildRouteCatalog(rows = []) {
  const catalog = new Map();
  for (const row of rows) {
    if (!row || row.Id == null) continue;
    const route = {
      name: String(row.nameZh || row.nameEn || row.Id),
      departure: String(row.departureZh || row.departureEn || ''),
      destination: String(row.destinationZh || row.destinationEn || ''),
      operator: String(row.providerName || ''),
      shapeRouteId: String(row.Id),
    };
    catalog.set(String(row.Id), route);
    if (row.pathAttributeId != null) catalog.set(String(row.pathAttributeId), route);
  }
  return catalog;
}

export function normalizeBusSnapshot(vehicleBody, routeBody, { nowMs = Date.now(), staleAfterSec = 120 } = {}) {
  const catalog = buildRouteCatalog(routeBody?.BusInfo);
  const snapshotMs = taipeiTimeMs(vehicleBody?.EssentialInfo?.UpdateTime);
  const byPlate = new Map();
  let rejected = 0;

  for (const row of vehicleBody?.BusInfo || []) {
    const plate = String(row?.BusID || '').trim();
    const routeId = String(row?.RouteID ?? '');
    const lat = finite(row?.Latitude);
    const lon = finite(row?.Longitude);
    const dataMs = taipeiTimeMs(row?.DataTime) ?? snapshotMs;
    const ageSec = dataMs == null ? null : Math.max(0, Math.floor((nowMs - dataMs) / 1000));
    const active = String(row?.DutyStatus) === '1' && String(row?.BusStatus) === '0';

    if (!plate || !routeId || routeId === '0' || !active || lat == null || lon == null ||
        lat < 21 || lat > 26.5 || lon < 119 || lon > 123 || ageSec == null || ageSec > staleAfterSec) {
      rejected += 1;
      continue;
    }

    const route = catalog.get(routeId) || { name: routeId, departure: '', destination: '', operator: '' };
    const rawDirection = Number(row.GoBack);
    const direction = rawDirection === 0 || rawDirection === 1 ? rawDirection : null;
    const bus = {
      id: plate,
      plate,
      route: route.name,
      routeId,
      shapeRouteId: route.shapeRouteId || routeId,
      operator: route.operator,
      direction,
      destination: direction === 0 ? route.destination : direction === 1 ? route.departure : '',
      lat,
      lon,
      speed: Math.max(0, finite(row.Speed) || 0),
      bearing: ((finite(row.Azimuth) || 0) % 360 + 360) % 360,
      updatedAt: new Date(dataMs).toISOString(),
      ageSec,
    };
    const previous = byPlate.get(plate);
    if (!previous || bus.updatedAt > previous.updatedAt) byPlate.set(plate, bus);
  }

  const buses = [...byPlate.values()].sort((a, b) =>
    a.route.localeCompare(b.route, 'zh-Hant', { numeric: true }) || a.plate.localeCompare(b.plate));

  return {
    schemaVersion: 1,
    snapshotAt: snapshotMs == null ? null : new Date(snapshotMs).toISOString(),
    source: DATA_ATTRIBUTION,
    buses,
    totals: { source: vehicleBody?.BusInfo?.length || 0, active: buses.length, rejected },
  };
}

export async function readGzipJson(response) {
  if (!response.ok) throw new Error(`上游回應 ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(raw.toString('utf8'));
}
