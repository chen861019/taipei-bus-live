import assert from 'node:assert/strict';
import test from 'node:test';
import { describeBusMotion, formatRelativeAge } from '../public/presentation.mjs';

test('資料時間以使用者可理解的相對時間呈現', () => {
  const now = Date.parse('2026-10-04T12:00:30.000Z');
  assert.equal(formatRelativeAge('2026-10-04T12:00:27.000Z', now), '剛剛');
  assert.equal(formatRelativeAge('2026-10-04T12:00:10.000Z', now), '20 秒前');
  assert.equal(formatRelativeAge('2026-10-04T11:58:00.000Z', now), '2 分鐘前');
});

test('路線匹配信心轉成清楚但不假裝精密的狀態', () => {
  assert.equal(describeBusMotion({ motionMode: 'route', motionConfidence: 90 }).label, '穩定推估');
  assert.equal(describeBusMotion({ motionMode: 'route', motionConfidence: 30 }).tone, 'warning');
  assert.equal(describeBusMotion({ motionMode: 'bearing' }).label, '方位推估');
});
