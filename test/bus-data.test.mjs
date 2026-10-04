import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteCatalog, normalizeBusSnapshot, taipeiTimeMs } from '../src/bus-data.mjs';

const routes = { BusInfo: [{ Id: 101, pathAttributeId: 1010, nameZh: '紅5', departureZh: '捷運劍潭站', destinationZh: '陽明山', providerName: '測試客運' }] };
const nowMs = Date.parse('2026-09-28T12:00:30Z');

test('台北時間不依執行主機時區漂移', () => {
  assert.equal(taipeiTimeMs('2026/09/28 20:00:25'), Date.parse('2026-09-28T12:00:25Z'));
});

test('RouteID 可用 pathAttributeId 找到乘客可讀的路線名', () => {
  const catalog = buildRouteCatalog(routes.BusInfo);
  assert.equal(catalog.get('1010').name, '紅5');
});

test('只保留新鮮、營運中、有路線的車輛', () => {
  const vehicleBody = {
    EssentialInfo: { UpdateTime: '2026/09/28 20:00:25' },
    BusInfo: [
      { BusID: 'AAA-001', DutyStatus: '1', BusStatus: '0', RouteID: '1010', GoBack: '0', Longitude: '121.55', Latitude: '25.10', Speed: '32', Azimuth: '361', DataTime: '2026-09-28 20:00:20' },
      { BusID: 'OFF-002', DutyStatus: '2', BusStatus: '0', RouteID: '1010', GoBack: '0', Longitude: '121.55', Latitude: '25.10', DataTime: '2026-09-28 20:00:20' },
      { BusID: 'NONE-003', DutyStatus: '1', BusStatus: '0', RouteID: '0', GoBack: '0', Longitude: '121.55', Latitude: '25.10', DataTime: '2026-09-28 20:00:20' },
      { BusID: 'OLD-004', DutyStatus: '1', BusStatus: '0', RouteID: '1010', GoBack: '0', Longitude: '121.55', Latitude: '25.10', DataTime: '2026-09-28 19:50:00' },
    ],
  };
  const result = normalizeBusSnapshot(vehicleBody, routes, { nowMs });
  assert.equal(result.buses.length, 1);
  assert.deepEqual(result.buses[0], {
    id: 'AAA-001', plate: 'AAA-001', route: '紅5', routeId: '1010', shapeRouteId: '101', operator: '測試客運', direction: 0,
    destination: '陽明山', lat: 25.1, lon: 121.55, speed: 32, bearing: 1,
    updatedAt: '2026-09-28T12:00:20.000Z', ageSec: 10,
  });
});
