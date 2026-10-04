import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRouteMotion, buildShapeIndex, createRouteMotionModel, predictOnRoute } from '../src/route-motion.mjs';

const shapeIndex = buildShapeIndex([{
  RouteID: 10, SubRouteID: -1, GoBack: 0,
  wkt: 'LINESTRING (121.5 25, 121.501 25, 121.501 25.001)',
}]);
const bus = {
  id: 'TEST-1', routeId: '100', shapeRouteId: '10', direction: 0,
  lon: 121.5001, lat: 25.00005, speed: 36, bearing: 90,
  updatedAt: '2026-09-28T14:00:00.000Z',
};

test('主路線代碼可建立輕量軌跡索引', () => {
  assert.ok(shapeIndex.get('main:10:0'));
  assert.equal(shapeIndex.get('main:10:0').longitude.constructor, Float64Array);
});

test('GPS 先吸附路線，再沿折線而非直線前進', () => {
  const model = createRouteMotionModel(bus, shapeIndex);
  const point = predictOnRoute(model, Date.parse('2026-09-28T14:00:15.000Z'));
  assert.ok(point.lon > 121.5009);
  assert.ok(point.lat > 25);
  assert.ok(point.bearing < 10 || point.bearing > 350);
});

test('離路線過遠時保留原始 GPS，避免吸到錯誤道路', () => {
  assert.equal(createRouteMotionModel({ ...bus, lat: 25.01 }, shapeIndex), null);
});

test('輸出保留官方回報時間並標示推估時間與模式', () => {
  const model = createRouteMotionModel(bus, shapeIndex);
  const models = new Map([[bus.id, model]]);
  const atMs = Date.parse('2026-09-28T14:00:05.000Z');
  const [result] = applyRouteMotion([bus], models, atMs);
  assert.equal(result.updatedAt, bus.updatedAt);
  assert.equal(result.estimatedAt, '2026-09-28T14:00:05.000Z');
  assert.equal(result.motionMode, 'route');
  assert.equal(result.motionSpeedKph, 36);
  assert.ok(result.motionConfidence >= 80);
});

test('α-β 濾波在 GPS 落後預測時平順減速但不回溯', () => {
  const first = createRouteMotionModel(bus, shapeIndex);
  const delayedGps = {
    ...bus,
    lon: 121.5002,
    updatedAt: '2026-09-28T14:00:10.000Z',
  };
  const filtered = createRouteMotionModel(delayedGps, shapeIndex, { previousModel: first });
  assert.ok(filtered.progress > first.progress);
  assert.ok(filtered.progress > 40);
  assert.ok(filtered.progress < 100);
  assert.ok(filtered.speedMps < first.speedMps);
});

test('相同車輛回報時間不重複套用濾波', () => {
  const first = createRouteMotionModel(bus, shapeIndex);
  assert.equal(createRouteMotionModel(bus, shapeIndex, { previousModel: first }), first);
});

test('重疊路段優先選擇接近上一沿線進度的候選段', () => {
  const overlappingIndex = buildShapeIndex([{
    RouteID: 20, SubRouteID: -1, GoBack: 0,
    wkt: 'LINESTRING (121.5 25, 121.501 25, 121.5 25, 121.501 25)',
  }]);
  const track = overlappingIndex.get('main:20:0');
  const previousModel = {
    track, progress: 230, speedMps: 0,
    reportedAtMs: Date.parse('2026-09-28T14:00:00.000Z'), confidence: 1,
  };
  const next = createRouteMotionModel({
    ...bus, shapeRouteId: '20', lon: 121.5005,
    updatedAt: '2026-09-28T14:00:10.000Z',
  }, overlappingIndex, { previousModel });
  assert.ok(next.progress > 240);
});

test('低信心匹配會縮短外插時間', () => {
  const model = createRouteMotionModel(bus, shapeIndex);
  const at15 = Date.parse('2026-09-28T14:00:15.000Z');
  const high = predictOnRoute({ ...model, confidence: 1 }, at15);
  const low = predictOnRoute({ ...model, confidence: 0.25 }, at15);
  assert.ok(low.routeProgress < high.routeProgress);
});
