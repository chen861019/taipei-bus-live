import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRouteStopIndex, routeStops } from '../src/route-stops.mjs';

test('站牌依主路線、方向與站序建立精簡索引', () => {
  const index = buildRouteStopIndex([
    { Id: 2, routeId: 101, goBack: '0', seqNo: 2, nameZh: '第二站', longitude: '121.52', latitude: '25.02', address: '測試路2號', bearing: 'E' },
    { Id: 1, routeId: 101, goBack: '0', seqNo: 1, nameZh: '第一站', showLon: '121.51', showLat: '25.01' },
    { Id: 3, routeId: 101, goBack: '1', seqNo: 1, nameZh: '回程站', longitude: '121.53', latitude: '25.03' },
    { Id: 4, routeId: 101, goBack: '2', seqNo: 3, nameZh: '未知方向', longitude: '121.54', latitude: '25.04' },
  ]);
  assert.deepEqual(routeStops(index, '101', 0), [
    { id: '1', name: '第一站', sequence: 1, lon: 121.51, lat: 25.01, bearing: '', address: '' },
    { id: '2', name: '第二站', sequence: 2, lon: 121.52, lat: 25.02, bearing: 'E', address: '測試路2號' },
  ]);
  assert.equal(routeStops(index, '101', 1).length, 1);
  assert.deepEqual(routeStops(index, '404', 0), []);
});

test('無效座標與缺少站名的資料不進入索引', () => {
  const index = buildRouteStopIndex([
    { Id: 1, routeId: 101, goBack: 0, seqNo: 1, nameZh: '', longitude: 121.5, latitude: 25 },
    { Id: 2, routeId: 101, goBack: 0, seqNo: 2, nameZh: '壞座標', longitude: 0, latitude: 0 },
  ]);
  assert.deepEqual(routeStops(index, 101, 0), []);
});
