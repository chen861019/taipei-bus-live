import * as maplibregl from '/vendor/maplibre-gl.mjs';
import { followCoordinate, predictBusCoordinate, stabilizeRouteTarget } from '/bus-motion.mjs';
import { describeBusMotion, formatRelativeAge } from '/presentation.mjs';

(function () {
  'use strict';

  const TAIPEI_CENTER = [121.5434, 25.0444];
  const EMPTY = { type: 'FeatureCollection', features: [] };
  const REFRESH_MS = 1_000;
  const MOTION_MS = 250;
  const state = {
    buses: [], busById: new Map(), motionGeojson: EMPTY, query: '', refreshTimer: null,
    motionTimer: null, loading: false, selected: null, snapshotAt: null, checkedAt: null,
  };

  const elements = {
    status: document.getElementById('statusText'), count: document.getElementById('busCount'),
    routes: document.getElementById('routeCount'), time: document.getElementById('updatedTime'),
    live: document.getElementById('liveStatus'), app: document.getElementById('appShell'),
    search: document.getElementById('searchInput'), filter: document.getElementById('filterStatus'),
    filterText: document.getElementById('filterText'), clearSearch: document.getElementById('clearSearchButton'),
    refresh: document.getElementById('refreshButton'), locate: document.getElementById('locateButton'),
    sheet: document.getElementById('busSheet'), close: document.getElementById('sheetClose'),
    motionStatus: document.getElementById('busMotionStatus'),
    motionDetail: document.getElementById('busMotionDetail'), age: document.getElementById('busAge'),
  };

  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/positron',
    center: TAIPEI_CENTER,
    zoom: 11.1,
    minZoom: 9,
    maxZoom: 18,
    maxBounds: [[121.20, 24.82], [121.85, 25.35]],
    attributionControl: true,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');

  function toGeojson(buses, previous = new Map()) {
    return {
      type: 'FeatureCollection',
      features: buses.map(bus => ({
        type: 'Feature', id: bus.id,
        geometry: { type: 'Point', coordinates: previous.get(bus.id) || [bus.lon, bus.lat] },
        // MapLibre only needs these two fields. Keep the full vehicle record in
        // state.busById so each 250ms setData call does not serialize operator,
        // timestamps and motion diagnostics for every marker.
        properties: { id: bus.id, route: bus.route },
      })),
    };
  }

  function installLayers() {
    if (!map.getSource('buses')) map.addSource('buses', { type: 'geojson', data: state.motionGeojson, cluster: true, clusterMaxZoom: 13, clusterRadius: 34 });
    if (!map.getLayer('bus-clusters')) map.addLayer({
      id: 'bus-clusters', type: 'circle', source: 'buses', filter: ['has', 'point_count'],
      paint: {
        'circle-color': ['step', ['get', 'point_count'], '#2563eb', 30, '#1d4ed8', 100, '#1e40af'],
        'circle-radius': ['step', ['get', 'point_count'], 16, 30, 20, 100, 25],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
      },
    });
    if (!map.getLayer('bus-cluster-count')) map.addLayer({
      id: 'bus-cluster-count', type: 'symbol', source: 'buses', filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 12 },
      paint: { 'text-color': '#ffffff' },
    });
    if (!map.getLayer('bus-points')) map.addLayer({
      id: 'bus-points', type: 'circle', source: 'buses', filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': '#ea580c',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7, 17, 9],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
      },
    });
    if (!map.getLayer('bus-selected')) map.addLayer({
      id: 'bus-selected', type: 'circle', source: 'buses',
      filter: ['==', ['get', 'id'], state.selected || ''],
      paint: {
        'circle-color': 'rgba(255,255,255,0)',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 11, 17, 15],
        'circle-stroke-color': '#0f172a', 'circle-stroke-width': 3,
      },
    });
    if (!map.getLayer('bus-labels')) map.addLayer({
      id: 'bus-labels', type: 'symbol', source: 'buses', filter: ['!', ['has', 'point_count']], minzoom: 12.5,
      layout: {
        'text-field': ['get', 'route'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top',
        'text-allow-overlap': false,
      },
      paint: { 'text-color': '#0f172a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    });
  }

  function normalized(value) { return String(value || '').trim().toLowerCase().replace(/臺/g, '台'); }

  function matchingBuses() {
    const query = normalized(state.query);
    if (!query) return state.buses;
    return state.buses.filter(bus => normalized(bus.route).includes(query) || normalized(bus.plate).includes(query));
  }

  function applyFilter({ fit = false, preservePositions = false } = {}) {
    if (!map.getLayer('bus-points')) return;
    const query = normalized(state.query);
    const matches = matchingBuses();
    // Feed only matching vehicles into the clustered source. This keeps search
    // results visible at every zoom level instead of hiding them inside clusters.
    const previous = preservePositions
      ? new Map(state.motionGeojson.features.map(feature => [feature.properties.id, feature.geometry.coordinates]))
      : new Map();
    state.motionGeojson = toGeojson(matches, previous);
    map.getSource('buses')?.setData(state.motionGeojson);
    elements.filter.hidden = !query;
    elements.filterText.textContent = query
      ? matches.length
        ? `符合「${state.query.trim()}」：${matches.length} 輛`
        : `找不到「${state.query.trim()}」的營運車輛`
      : '';
    elements.filter.dataset.empty = String(Boolean(query && !matches.length));
    if (fit && query && matches.length) {
      const bounds = new maplibregl.LngLatBounds();
      matches.slice(0, 100).forEach(bus => bounds.extend([bus.lon, bus.lat]));
      map.fitBounds(bounds, { padding: 90, maxZoom: 14, duration: prefersReducedMotion() ? 0 : 450 });
    }
  }

  function prefersReducedMotion() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }

  function animateVehicles() {
    if (document.hidden || prefersReducedMotion() || map.getZoom() < 13 || map.isMoving?.() || !state.motionGeojson.features.length) return;
    const nowMs = Date.now();
    const bounds = map.getBounds?.();
    let changed = false;
    for (const feature of state.motionGeojson.features) {
      const bus = state.busById.get(feature.properties.id);
      if (!bus) continue;
      const target = predictBusCoordinate(bus, nowMs);
      if (bounds && !bounds.contains(feature.geometry.coordinates) && !bounds.contains(target)) continue;
      const motionSpeedKph = Number(bus.motionSpeedKph ?? bus.speed);
      const maximumMetersPerSecond = Math.min(80 / 3.6, Math.max(6, motionSpeedKph / 3.6 * 1.35 + 2));
      const next = followCoordinate(feature.geometry.coordinates, target, {
        maximumStepMeters: maximumMetersPerSecond * MOTION_MS / 1000,
      });
      if (next[0] !== feature.geometry.coordinates[0] || next[1] !== feature.geometry.coordinates[1]) changed = true;
      feature.geometry.coordinates = next;
    }
    if (changed) map.getSource('buses')?.setData(state.motionGeojson);
  }
  function timeText(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
  }

function updateSummary() {
    const routes = new Set(state.buses.map(bus => bus.route));
    elements.count.textContent = state.buses.length.toLocaleString('zh-TW');
    elements.routes.textContent = routes.size.toLocaleString('zh-TW');
  }

  function updateConnectionStatus(body) {
    const snapshotMs = Date.parse(body.snapshotAt);
    const checkedMs = Date.parse(state.checkedAt);
    const ageSec = Number.isFinite(snapshotMs) && Number.isFinite(checkedMs)
      ? Math.max(0, Math.floor((checkedMs - snapshotMs) / 1000))
      : 0;
    const delayed = ageSec > 30;
    elements.status.textContent = delayed
      ? `資料延遲 · 保留 ${state.buses.length.toLocaleString('zh-TW')} 輛車況`
      : `已連線 · ${state.buses.length.toLocaleString('zh-TW')} 輛營運中`;
    elements.live.dataset.state = delayed ? 'stale' : 'online';
  }

  async function refresh({ showIndicator = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    if (showIndicator) {
      elements.refresh.dataset.loading = 'true';
      elements.refresh.disabled = true;
      elements.refresh.setAttribute?.('aria-busy', 'true');
    }
    try {
      const response = await fetch('/api/buses', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.schemaVersion !== 1 || !Array.isArray(body.buses)) throw new Error('資料格式錯誤');
      state.checkedAt = body.checkedAt || body.snapshotAt;
      const referenceMs = Date.parse(state.checkedAt) || Date.now();
      elements.time.textContent = formatRelativeAge(body.snapshotAt, referenceMs);
      elements.time.title = `官方快照：${timeText(body.snapshotAt)}；系統檢查：${timeText(state.checkedAt)}`;
      // The browser checks every second, but the official snapshot may not
      // change that often. Avoid rebuilding hundreds of map features when the
      // upstream timestamp is identical, which keeps memory churn low.
      const snapshotChanged = body.snapshotAt !== state.snapshotAt;
      state.buses = body.buses.map(bus => stabilizeRouteTarget(state.busById.get(bus.id), bus));
      state.busById = new Map(state.buses.map(bus => [bus.id, bus]));
      updateConnectionStatus(body);
      if (snapshotChanged) {
        state.snapshotAt = body.snapshotAt;
        installLayers();
  updateSummary();
        applyFilter({ preservePositions: true });
      }
      updateSelectedBus();
    } catch (error) {
      elements.status.textContent = state.buses.length ? '更新失敗，保留上一份車況' : '目前無法取得公車位置';
      elements.live.dataset.state = state.buses.length ? 'stale' : 'error';
    } finally {
      state.loading = false;
      if (showIndicator) {
        elements.refresh.dataset.loading = 'false';
        elements.refresh.disabled = false;
      }
      elements.refresh.setAttribute?.('aria-busy', 'false');
    }
  }

  function renderBus(bus) {
    if (!bus) return;
    document.getElementById('busRoute').textContent = bus.route;
    document.getElementById('busTitle').textContent = bus.plate;
    document.getElementById('busDestination').textContent = bus.destination ? `往 ${bus.destination}` : '方向資料未提供';
    document.getElementById('busPlate').textContent = bus.plate;
    document.getElementById('busSpeed').textContent = `${bus.speed} km/h`;
    document.getElementById('busOperator').textContent = bus.operator || '未提供';
    document.getElementById('busUpdated').textContent = timeText(bus.updatedAt);
    elements.age.textContent = formatRelativeAge(bus.updatedAt, Date.parse(state.checkedAt) || Date.now());
    document.getElementById('busChecked').textContent = timeText(state.checkedAt);
    const motion = describeBusMotion(bus);
    elements.motionStatus.textContent = motion.label;
    elements.motionStatus.dataset.tone = motion.tone;
    elements.motionDetail.textContent = motion.detail;
  }

  function updateSelectedLayer() {
    map.setFilter?.('bus-selected', ['==', ['get', 'id'], state.selected || '']);
  }

  function showBus(bus) {
    if (!bus) return;
    state.selected = bus.id;
    updateSelectedLayer();
    renderBus(bus);
    const wasHidden = elements.sheet.hidden;
    elements.sheet.hidden = false;
    elements.app.dataset.sheetOpen = 'true';
    if (wasHidden) elements.close.focus({ preventScroll: true });
  }

  function closeSheet() {
    elements.sheet.hidden = true;
    state.selected = null;
    elements.app.dataset.sheetOpen = 'false';
    updateSelectedLayer();
    map.getCanvas().focus?.({ preventScroll: true });
  }

  function updateSelectedBus() {
    if (!state.selected) return;
    const bus = state.buses.find(item => item.id === state.selected);
    if (bus) renderBus(bus);
    else closeSheet();
  }

  map.on('load', () => { installLayers(); refresh({ showIndicator: true }); });
  map.on('style.load', () => { if (map.loaded()) installLayers(); });
  map.on('click', 'bus-clusters', event => {
    const feature = event.features?.[0]; if (!feature) return;
    map.getSource('buses').getClusterExpansionZoom(feature.properties.cluster_id).then(zoom => {
      map.easeTo({ center: feature.geometry.coordinates, zoom, duration: prefersReducedMotion() ? 0 : 400 });
    });
  });
  map.on('click', 'bus-points', event => {
    const feature = event.features?.[0]; if (!feature) return;
    showBus(state.buses.find(bus => bus.id === feature.properties.id));
  });
  for (const layer of ['bus-clusters', 'bus-points']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }

  let searchTimer;
  elements.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = elements.search.value; applyFilter({ fit: true }); }, 180);
  });
  elements.clearSearch.addEventListener('click', () => {
    elements.search.value = '';
    state.query = '';
    applyFilter();
    elements.search.focus();
  });
  elements.refresh.addEventListener('click', () => {
    elements.refresh.setAttribute?.('aria-busy', 'true');
    refresh({ showIndicator: true });
  });
  elements.close.addEventListener('click', closeSheet);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !elements.sheet.hidden) closeSheet(); });
  elements.locate.addEventListener('click', () => {
    if (!navigator.geolocation) { elements.status.textContent = '此瀏覽器不支援定位'; return; }
    elements.locate.disabled = true;
    navigator.geolocation.getCurrentPosition(position => {
      map.easeTo({ center: [position.coords.longitude, position.coords.latitude], zoom: 15, duration: prefersReducedMotion() ? 0 : 500 });
      elements.locate.disabled = false;
    }, () => {
      elements.status.textContent = '無法取得位置，請檢查定位權限';
      elements.locate.disabled = false;
    }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
  });

  state.refreshTimer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  state.motionTimer = setInterval(animateVehicles, MOTION_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
