import assert from 'node:assert/strict';
import test from 'node:test';
import { followCoordinate, predictBusCoordinate, stabilizeRouteTarget } from '../public/bus-motion.mjs';

const bus = {
  lon: 121.5,
  lat: 25,
  speed: 36,
  bearing: 90,
  updatedAt: '2026-09-28T14:00:00.000Z',
};

test('依速度與方位向前推估位置', () => {
  const [lon, lat] = predictBusCoordinate(bus, Date.parse('2026-09-28T14:00:10.000Z'));
  assert.ok(lon > bus.lon);
  assert.ok(Math.abs(lat - bus.lat) < 0.00001);
});

test('低速車不推估，避免停站時漂移', () => {
  assert.deepEqual(
    predictBusCoordinate({ ...bus, speed: 2 }, Date.parse('2026-09-28T14:00:10.000Z')),
    [bus.lon, bus.lat],
  );
});

test('推估時間最多十五秒', () => {
  const at15 = predictBusCoordinate(bus, Date.parse('2026-09-28T14:00:15.000Z'));
  const at60 = predictBusCoordinate(bus, Date.parse('2026-09-28T14:01:00.000Z'));
  assert.deepEqual(at60, at15);
});

test('新定位以目前顯示位置為起點平滑校正', () => {
  assert.deepEqual(followCoordinate([0, 0], [2, 4]), [1, 2]);
});

test('遠距離新定位的單次追趕距離受上限約束', () => {
  const current = [121.5, 25];
  const target = [121.503, 25];
  const result = followCoordinate(current, target, { maximumStepMeters: 5 });
  const movedMeters = (result[0] - current[0]) * 111_320 * Math.cos(25 * Math.PI / 180);
  assert.ok(movedMeters > 4.9 && movedMeters <= 5.01);
});

test('同一路線的新推估倒退時維持上一個目標，避免來回跳', () => {
  const previous = { lon: 121.501, lat: 25, routeKey: 'main:10:0', routeProgress: 500, routeLength: 2_000 };
  const next = { lon: 121.499, lat: 25, routeKey: 'main:10:0', routeProgress: 430, routeLength: 2_000 };
  const result = stabilizeRouteTarget(previous, next);
  assert.equal(result.lon, previous.lon);
  assert.equal(result.lat, previous.lat);
  assert.equal(result.routeProgress, previous.routeProgress);
});

test('環狀路線通過終點時允許進度回到起點', () => {
  const previous = { lon: 121.5, lat: 25, routeKey: 'loop:0', routeProgress: 950, routeLength: 1_000 };
  const next = { lon: 121.501, lat: 25, routeKey: 'loop:0', routeProgress: 30, routeLength: 1_000 };
  assert.equal(stabilizeRouteTarget(previous, next), next);
});
