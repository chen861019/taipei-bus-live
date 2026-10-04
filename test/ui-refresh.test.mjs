import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { followCoordinate, predictBusCoordinate, stabilizeRouteTarget } from '../public/bus-motion.mjs';
import { describeBusMotion, formatRelativeAge } from '../public/presentation.mjs';

const APP_URL = new URL('../public/app.js', import.meta.url);
const flush = () => new Promise(resolve => setImmediate(resolve));

function response(body) {
  return Promise.resolve({ ok: true, json: async () => body });
}

function snapshot(snapshotAt, updatedAt = snapshotAt) {
  return {
    schemaVersion: 1,
    snapshotAt,
    checkedAt: updatedAt,
    buses: [{
      id: 'BUS-1', plate: 'BUS-1', route: '307', routeId: '307', operator: '測試客運',
      direction: 0, destination: '台北車站', lat: 25.04, lon: 121.54,
      speed: 12, bearing: 90, updatedAt, ageSec: 0,
    }],
  };
}

async function harness(fetches) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, dataset: {}, disabled: false, hidden: id === 'busSheet' || id === 'filterStatus',
      style: {}, textContent: '', value: '', listeners: new Map(),
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      focus() {},
    });
    return elements.get(id);
  };

  class FakeMap {
    constructor() { this.handlers = new Map(); this.sources = new Map(); this.layers = new Map(); }
    addControl() {}
    on(name, layer, listener) {
      if (typeof layer === 'function') this.handlers.set(name, layer);
      else this.handlers.set(`${name}:${layer}`, listener);
    }
    addSource(id) {
      this.sources.set(id, {
        data: null,
        setData(data) { this.data = data; },
        getClusterExpansionZoom: async () => 12,
      });
    }
    getSource(id) { return this.sources.get(id); }
    addLayer(layer) { this.layers.set(layer.id, layer); }
    getLayer(id) { return this.layers.get(id); }
    setFilter(id, filter) { if (this.layers.has(id)) this.layers.get(id).filter = filter; }
    getCanvas() { return { style: {} }; }
    getZoom() { return 14; }
    fitBounds() {}
    easeTo() {}
  }

  const intervals = new Map();
  const fakeMap = new FakeMap();
  const context = vm.createContext({
    console,
    document: {
      hidden: false,
      getElementById: element,
      addEventListener() {},
    },
    fetch: () => {
      const next = fetches.shift();
      if (!next) throw new Error('Unexpected fetch');
      return next;
    },
    maplibregl: {
      Map: class { constructor() { return fakeMap; } },
      NavigationControl: class {},
      LngLatBounds: class { extend() { return this; } },
    },
    matchMedia: () => ({ matches: true }),
    predictBusCoordinate,
    followCoordinate,
    stabilizeRouteTarget,
    describeBusMotion,
    formatRelativeAge,
    setInterval(callback, milliseconds) { intervals.set(milliseconds, callback); return intervals.size; },
    clearTimeout() {},
    setTimeout(callback) { callback(); return 1; },
  });

  const source = (await readFile(APP_URL, 'utf8')).replace(/^import .*?;\s*$/gm, '');
  vm.runInContext(source, context, { filename: 'public/app.js' });
  fakeMap.handlers.get('load')();
  await flush(); await flush();
  return { element, map: fakeMap, tick: () => intervals.get(1_000)() };
}

test('背景的一秒輪詢不顯示手動更新旋轉狀態', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const app = await harness([response(snapshot('2026-09-28T14:00:00.000Z')), pending]);
  app.tick();
  assert.equal(app.element('refreshButton').dataset.loading, 'false');
  release({ ok: true, json: async () => snapshot('2026-09-28T14:00:00.000Z', '2026-09-28T14:00:01.000Z') });
  await flush();
});

test('相同官方快照只更新精確檢查資訊，不假裝有新資料', async () => {
  const app = await harness([
    response(snapshot('2026-09-28T14:00:00.000Z')),
    response(snapshot('2026-09-28T14:00:00.000Z', '2026-09-28T14:00:01.000Z')),
  ]);
  const beforeTitle = app.element('updatedTime').title;
  app.tick();
  await flush(); await flush();
  assert.equal(app.element('updatedTime').textContent, '剛剛');
  assert.notEqual(app.element('updatedTime').title, beforeTitle);
});

test('摘要顯示官方資料年齡，不把每秒檢查誤認成新 GPS', async () => {
  const app = await harness([
    response(snapshot('2026-09-28T14:00:00.000Z')),
    response(snapshot('2026-09-28T14:00:00.000Z', '2026-09-28T14:00:20.000Z')),
  ]);
  app.tick();
  await flush(); await flush();
  assert.equal(app.element('updatedTime').textContent, '20 秒前');
});

test('官方快照超過三十秒時清楚標示資料延遲', async () => {
  const app = await harness([response(snapshot(
    '2026-09-28T14:00:00.000Z',
    '2026-09-28T14:00:31.000Z',
  ))]);
  assert.equal(app.element('liveStatus').dataset.state, 'stale');
  assert.match(app.element('statusText').textContent, /資料延遲/);
});

test('已開啟的車輛資訊會跟著新快照更新', async () => {
  const app = await harness([
    response(snapshot('2026-09-28T14:00:00.000Z')),
    response(snapshot('2026-09-28T14:00:01.000Z')),
  ]);
  app.map.handlers.get('click:bus-points')({ features: [{ properties: { id: 'BUS-1' } }] });
  const before = app.element('busUpdated').textContent;
  app.tick();
  await flush(); await flush();
  assert.notEqual(app.element('busUpdated').textContent, before);
});

test('已開啟的車輛資訊卡每秒更新檢查時間', async () => {
  const app = await harness([
    response(snapshot('2026-09-28T14:00:00.000Z')),
    response(snapshot('2026-09-28T14:00:00.000Z', '2026-09-28T14:00:01.000Z')),
  ]);
  app.map.handlers.get('click:bus-points')({ features: [{ properties: { id: 'BUS-1' } }] });
  const before = app.element('busChecked').textContent;
  app.tick();
  await flush(); await flush();
  assert.notEqual(app.element('busChecked').textContent, before);
});

test('車輛資訊卡清楚標示位置推估方式', async () => {
  const app = await harness([response(snapshot('2026-09-28T14:00:00.000Z'))]);
  app.map.handlers.get('click:bus-points')({ features: [{ properties: { id: 'BUS-1' } }] });
  assert.equal(app.element('busMotionStatus').textContent, '方位推估');
  assert.match(app.element('busMotionDetail').textContent, /速度與方位/);
});

test('地圖來源只保留繪圖必要欄位，避免動畫重複序列化完整車況', async () => {
  const app = await harness([response(snapshot('2026-09-28T14:00:00.000Z'))]);
  const [feature] = app.map.getSource('buses').data.features;
  assert.deepEqual(Object.keys(feature.properties).sort(), ['id', 'route']);
});

test('選取車輛會同步高亮標記與開啟資訊卡狀態', async () => {
  const app = await harness([response(snapshot('2026-09-28T14:00:00.000Z'))]);
  app.map.handlers.get('click:bus-points')({ features: [{ properties: { id: 'BUS-1' } }] });
  assert.equal(app.element('appShell').dataset.sheetOpen, 'true');
  assert.equal(app.map.getLayer('bus-selected').filter.at(-1), 'BUS-1');
});
