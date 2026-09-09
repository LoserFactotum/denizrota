// DenizRota web — arayuz ve akis.
// Hesap web worker'da calisir; bu dosya yalnizca gosterim, giris ve seyir takibi.

import { MapView, DEPTH_LEGEND } from './mapview.js';
import { searchPlaces, parseCoordinates, reverseName } from './geocode.js';
import * as store from './store.js';
import { routeToGPX, parseGPX, download } from './gpx.js';
import { sunTimes } from './sun.js';
import {
  distanceMeters, initialBearingDeg, crossTrackMeters,
  knotsFromMps, mpsFromKnots, etaSeconds, routeDistanceMeters,
} from './engine/navmath.js';

// ------------------------------------------------------------------ sabitler

// Tekne on ayarlari. Su cekimi degerleri uretici brosurunden; kendi teknenizin
// belgesindeki degeri girin — salma secenegine gore degisir.
const BOAT_PRESETS = {
  dufour470: {
    label: 'Dufour 470 · standart salma',
    draft: 2.2, underKeel: 1.0, modelAllowance: 5.0, waterLevelDrop: 0.3, horizontalBuffer: 150,
    beam: 4.74,
  },
  'dufour470-shoal': {
    label: 'Dufour 470 · sig salma',
    draft: 1.8, underKeel: 1.0, modelAllowance: 5.0, waterLevelDrop: 0.3, horizontalBuffer: 150,
    beam: 4.74,
  },
};
const BOAT_KEYS = ['draft', 'underKeel', 'modelAllowance', 'waterLevelDrop', 'horizontalBuffer'];
const pick = (preset) => Object.fromEntries(BOAT_KEYS.map(k => [k, preset[k]]));
const DEFAULT_BOAT = pick(BOAT_PRESETS.dufour470);

const BOAT_FIELDS = [
  { key: 'draft', label: 'Su cekimi', hint: 'Teknenin su altindaki en derin noktasi', min: 0.1, max: 15, step: 0.1, unit: 'm' },
  { key: 'underKeel', label: 'Omurga altinda pay', hint: 'Altinda birakmak istediginiz bosluk', min: 0, max: 10, step: 0.1, unit: 'm' },
  { key: 'modelAllowance', label: 'Ek model payi', hint: 'Sectiginiz tolerans — olculmus hata siniri degil', min: 0, max: 50, step: 0.5, unit: 'm' },
  { key: 'waterLevelDrop', label: 'Su seviyesi dususu', hint: 'Beklenen en dusuk su seviyesi farki', min: 0, max: 10, step: 0.1, unit: 'm' },
  { key: 'horizontalBuffer', label: 'Kiyi ve engel uzakligi', hint: 'Kiyidan ve engelden en az bu kadar uzak kal', min: 0, max: 2000, step: 10, unit: 'm' },
];

const ADVANCE_METRES = 50;
const XTE_WARN_METRES = 200;
const FIX_MAX_AGE_MS = 15000;
const FIX_MAX_ACCURACY_M = 50;

// -------------------------------------------------------------------- durum

const state = {
  id: crypto.randomUUID(),
  name: 'Yeni rota',
  points: [],            // kullanicinin noktalari (anchor)
  speedKnots: 5,
  boat: store.loadBoat(DEFAULT_BOAT),
  settings: store.loadSettings({ seamarks: true, resolution: 'auto', boatPreset: 'dufour470', ownWaters: true }),
  computed: null,        // worker sonucu
  // Kullanicinin gercek ucu modelce dogrulanamiyorsa (dar koy gibi), rota en
  // yakin uygun sudan hesaplanir ve aradaki parca DOGRULANMAMIS etap olarak
  // cizilir. Buradaki degerler o yerine gecen su noktalaridir.
  unverifiedEnds: { start: null, end: null },
  gridMode: null,        // null | 'depth' | 'cells'
  pendingHere: null,     // 'start' | 'add' — GPS gelince yapilacak konum islemi
  // Seyirde gidilen gercek iz. Cihazda saklanir; sayfa yenilense de kaybolmaz.
  track: store.loadTrack(),
  busy: false,
  tracking: null,        // {targetIndex, startedAt}
  position: null,
  showGrid: false,
  editingIndex: null,
  lastAlert: null,
};

let worker = null;
let searchController = null;
let searchTimer = null;
let wakeLock = null;
let watchId = null;

// ---------------------------------------------------------------------- DOM

const $ = (id) => document.getElementById(id);
const el = {
  searchInput: $('search-input'), searchClear: $('search-clear'), searchResults: $('search-results'),
  menuButton: $('menu-button'),
  modeBadge: $('mode-badge'), cacheBadge: $('cache-badge'),
  locate: $('locate-button'), fit: $('fit-button'), seamark: $('seamark-button'), gridButton: $('grid-button'),
  gpsChip: $('gps-chip'), alertStrip: $('alert-strip'),
  panel: $('panel'), panelGrip: $('panel-grip'),
  planView: $('plan-view'), trackView: $('track-view'),
  routeName: $('route-name'), reverse: $('reverse-button'), clear: $('clear-button'),
  pointList: $('point-list'), pointHint: $('point-hint'),
  mDistance: $('m-distance'), mDuration: $('m-duration'), mArrival: $('m-arrival'),
  mSpeedUnit: $('m-speed-unit'), mSun: $('m-sun'),
  speed: $('speed'), speedOut: $('speed-out'),
  calcButton: $('calc-button'), progress: $('progress'), progressFill: $('progress-fill'),
  progressText: $('progress-text'), cancelButton: $('cancel-button'), calcError: $('calc-error'),
  resultBlock: $('result-block'), resultSummary: $('result-summary'), legList: $('leg-list'),
  trackButton: $('track-button'),
  save: $('save-button'), routes: $('routes-button'),
  gpxExport: $('gpx-export'), gpxImport: $('gpx-import'), gpxFile: $('gpx-file'), share: $('share-button'),
  trackExport: $('track-export'), trackClear: $('track-clear'),
  boatFields: $('boat-fields'), requiredDepth: $('required-depth'), resolution: $('resolution'),
  boatPreset: $('boat-preset'), hereStart: $('here-start'), hereAdd: $('here-add'),
  ownWaters: $('own-waters'),
  unverifiedNote: $('unverified-note'), legend: $('legend'), legendScale: $('legend-scale'),
  provenance: $('provenance'),
  trackTarget: $('track-target'), trackSub: $('track-sub'), trackStop: $('track-stop'),
  tRemaining: $('t-remaining'), tSpeed: $('t-speed'), tEta: $('t-eta'), tArrival: $('t-arrival'),
  tBearing: $('t-bearing'), tXte: $('t-xte'), tDepth: $('t-depth'), tNext: $('t-next'),
  menuDialog: $('menu-dialog'), routesDialog: $('routes-dialog'), pointDialog: $('point-dialog'),
  aboutDialog: $('about-dialog'), confirmDialog: $('confirm-dialog'),
  routesList: $('routes-list'),
  pointDialogTitle: $('point-dialog-title'), pointName: $('point-name'),
  pointLat: $('point-lat'), pointLon: $('point-lon'), pointSave: $('point-save'), pointDelete: $('point-delete'),
  confirmTitle: $('confirm-title'), confirmText: $('confirm-text'),
  confirmYes: $('confirm-yes'), confirmNo: $('confirm-no'),
  buildNote: $('build-note'),
};

// ---------------------------------------------------------------- bicimleme

const nf = (digits) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const num = (value, digits = 1) => Number.isFinite(value) ? nf(digits).format(value) : '—';
const nm = (metres) => Number.isFinite(metres) ? nf(2).format(metres / 1852) : '—';

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3.2e8) return '—';
  if (seconds < 60) return '<1 dk';
  const minutes = Math.ceil(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} sa ${minutes % 60} dk` : `${minutes} dk`;
}

function clock(date) {
  return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

function arrivalText(seconds, now = new Date()) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3.2e8) return '—';
  const at = new Date(now.getTime() + seconds * 1000);
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay ? clock(at) : `${at.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} ${clock(at)}`;
}

const bearingText = (degrees) => Number.isFinite(degrees) ? `${String(Math.round(degrees) % 360).padStart(3, '0')}°` : '—';
const coordText = (p) => `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`;

// ----------------------------------------------------------------- harita

const map = new MapView('map', {
  onMapClick: (latitude, longitude) => addPoint({ latitude, longitude }),
  onMarkerDrag: (index, latitude, longitude) => {
    state.points[index] = { ...state.points[index], latitude, longitude };
    invalidateComputed();
    render();
  },
  onMarkerClick: (index) => openPointDialog(index),
});

// --------------------------------------------------------------- gecerlilik

function invalidateComputed() {
  state.unverifiedEnds = { start: null, end: null };
  if (state.computed) {
    state.computed = null;
    state.gridMode = null;
    map.setGrid(null);
    map.setBoundaries(null);
    el.gridButton.classList.remove('active');
    el.legend.hidden = true;
    stopTracking(true);
  }
}

/** Hesaba giden uclar: dogrulanamayan gercek uc yerine en yakin uygun su. */
function effectiveAnchors() {
  const anchors = state.points.map(p => ({ ...p }));
  if (anchors.length >= 2) {
    if (state.unverifiedEnds.start) anchors[0] = { ...state.unverifiedEnds.start, name: anchors[0].name };
    if (state.unverifiedEnds.end) anchors[anchors.length - 1] = { ...state.unverifiedEnds.end, name: anchors[anchors.length - 1].name };
  }
  return anchors;
}

/** Ekranda ve seyirde kullanilan tam nokta listesi; dogrulanmamis uclar dahil. */
function displayedPoints() {
  if (!state.computed) return state.points;
  const points = [...state.computed.points];
  if (state.unverifiedEnds.start) points.unshift({ ...state.points[0], unverified: true });
  if (state.unverifiedEnds.end) points.push({ ...state.points[state.points.length - 1], unverified: true });
  return points;
}

/** [a, b] ciftleri: derinlik kontrolu YAPILMAMIS parcalar. */
function unverifiedSegments() {
  if (!state.computed) return [];
  const c = state.computed.points;
  const segments = [];
  if (state.unverifiedEnds.start) segments.push([state.points[0], c[0]]);
  if (state.unverifiedEnds.end) segments.push([c[c.length - 1], state.points[state.points.length - 1]]);
  return segments;
}

function plannedSeconds() {
  return etaSeconds(routeDistanceMeters(displayedPoints()), mpsFromKnots(state.speedKnots));
}

// ------------------------------------------------------------------ noktalar

async function addPoint({ latitude, longitude, name }) {
  if (state.tracking) return;
  const index = state.points.length;
  const point = { latitude, longitude, name: name ?? `Nokta ${index + 1}` };
  state.points.push(point);
  invalidateComputed();
  render();
  map.fit(state.points.length > 1 ? state.points : []);
  if (!name) {
    const found = await reverseName(latitude, longitude).catch(() => null);
    if (found && state.points[index] === point) {
      point.name = found;
      render();
    }
  }
}

function openPointDialog(index) {
  if (state.tracking) return;
  const point = state.points[index];
  if (!point) return;
  state.editingIndex = index;
  el.pointDialogTitle.textContent = `${index + 1}. nokta`;
  el.pointName.value = point.name ?? '';
  el.pointLat.value = point.latitude.toFixed(6);
  el.pointLon.value = point.longitude.toFixed(6);
  el.pointDialog.showModal();
}

el.pointLat.addEventListener('input', () => {
  const parsed = parseCoordinates(el.pointLat.value);
  if (parsed && !parsed.shortLink && String(el.pointLat.value).match(/[,;\s]/)) {
    el.pointLat.value = parsed.latitude.toFixed(6);
    el.pointLon.value = parsed.longitude.toFixed(6);
  }
});

el.pointSave.addEventListener('click', () => {
  const index = state.editingIndex;
  if (index === null) return;
  const latitude = Number(String(el.pointLat.value).replace(',', '.'));
  const longitude = Number(String(el.pointLon.value).replace(',', '.'));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    el.pointLat.focus();
    return;
  }
  state.points[index] = { name: el.pointName.value.trim() || `Nokta ${index + 1}`, latitude, longitude };
  invalidateComputed();
  el.pointDialog.close();
  render();
});

el.pointDelete.addEventListener('click', () => {
  if (state.editingIndex === null) return;
  state.points.splice(state.editingIndex, 1);
  invalidateComputed();
  el.pointDialog.close();
  render();
});

// -------------------------------------------------------------------- arama

function renderSearchResults(rows, message) {
  el.searchResults.innerHTML = '';
  if (message) {
    const div = document.createElement('div');
    div.className = 'r-empty';
    div.textContent = message;
    el.searchResults.append(div);
    el.searchResults.hidden = false;
    return;
  }
  if (!rows.length) {
    el.searchResults.hidden = true;
    return;
  }
  for (const row of rows) {
    const wrapper = document.createElement('div');
    wrapper.className = 'r-row';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'r-add';
    const name = document.createElement('div');
    name.className = 'r-name';
    name.textContent = row.name;
    if (row.kind) {
      const kind = document.createElement('span');
      kind.className = 'r-kind';
      kind.textContent = row.kind;
      name.append(kind);
    }
    const detail = document.createElement('div');
    detail.className = 'r-detail';
    detail.textContent = [row.detail, row.source].filter(Boolean).join(' · ');
    button.append(name, detail);
    button.addEventListener('click', () => {
      closeSearch();
      map.flyTo(row.latitude, row.longitude, 13);
      map.showSearchPin(row.latitude, row.longitude, row.name);
      addPoint({ latitude: row.latitude, longitude: row.longitude, name: row.name });
      setTimeout(() => map.clearSearchPin(), 2500);
    });

    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'r-show';
    show.textContent = 'Goster';
    show.title = 'Rotaya eklemeden haritada goster';
    show.addEventListener('click', (event) => {
      event.stopPropagation();
      closeSearch();
      map.flyTo(row.latitude, row.longitude, 13);
      map.showSearchPin(row.latitude, row.longitude, row.name);
    });

    wrapper.append(button, show);
    el.searchResults.append(wrapper);
  }
  el.searchResults.hidden = false;
}

function closeSearch() {
  el.searchResults.hidden = true;
  el.searchInput.blur();
}

el.searchInput.addEventListener('input', () => {
  const query = el.searchInput.value.trim();
  el.searchClear.hidden = !query;
  clearTimeout(searchTimer);
  searchController?.abort();
  if (query.length < 2) { el.searchResults.hidden = true; return; }

  const coordinate = parseCoordinates(query);
  if (coordinate?.shortLink) {
    renderSearchResults([], 'Kisa Google baglantisi cozulemiyor. Baglantiyi tarayicida acip adres cubugundaki tam adresi yapistirin.');
    return;
  }
  searchTimer = setTimeout(async () => {
    searchController = new AbortController();
    renderSearchResults([], 'Araniyor…');
    try {
      const centre = map.centre;
      const rows = await searchPlaces(query, { ...centre, signal: searchController.signal });
      renderSearchResults(rows, rows.length ? null : 'Sonuc bulunamadi. Koordinat veya Google Maps baglantisi da yapistirabilirsiniz.');
    } catch (error) {
      if (error?.name !== 'AbortError') renderSearchResults([], 'Arama servisine ulasilamadi.');
    }
  }, 450);
});

el.searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    const first = el.searchResults.querySelector('button');
    if (first) first.click();
  }
  if (event.key === 'Escape') closeSearch();
});

el.searchClear.addEventListener('click', () => {
  el.searchInput.value = '';
  el.searchClear.hidden = true;
  el.searchResults.hidden = true;
  map.clearSearchPin();
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.search')) el.searchResults.hidden = true;
});

// ------------------------------------------------------------------- cizim

function renderPoints() {
  el.pointList.innerHTML = '';
  el.pointHint.hidden = state.points.length > 0;
  state.points.forEach((point, index) => {
    const li = document.createElement('li');
    li.className = 'point-row';
    li.draggable = !state.tracking;
    li.dataset.index = String(index);

    const badge = document.createElement('span');
    badge.className = 'point-index' + (index === state.points.length - 1 && index > 0 ? ' end' : '');
    badge.textContent = String(index + 1);

    const main = document.createElement('button');
    main.className = 'point-main';
    main.type = 'button';
    main.style.cssText = 'border:0;background:none;text-align:left;padding:0;';
    const name = document.createElement('div');
    name.className = 'point-name';
    name.textContent = point.name ?? `Nokta ${index + 1}`;
    const coord = document.createElement('div');
    coord.className = 'point-coord';
    coord.textContent = coordText(point);
    main.append(name, coord);
    main.addEventListener('click', () => openPointDialog(index));

    const drag = document.createElement('button');
    drag.className = 'point-drag';
    drag.type = 'button';
    drag.textContent = '⋮⋮';
    drag.setAttribute('aria-label', 'Sirayi degistir');

    const remove = document.createElement('button');
    remove.className = 'point-remove';
    remove.type = 'button';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', `${index + 1}. noktayi sil`);
    remove.addEventListener('click', () => {
      state.points.splice(index, 1);
      invalidateComputed();
      render();
    });

    li.append(badge, main, drag, remove);
    el.pointList.append(li);
  });
  wireDragAndDrop();
}

function wireDragAndDrop() {
  let dragIndex = null;
  el.pointList.querySelectorAll('.point-row').forEach((row) => {
    row.addEventListener('dragstart', (event) => {
      dragIndex = Number(row.dataset.index);
      row.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(dragIndex));
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      el.pointList.querySelectorAll('.over').forEach(r => r.classList.remove('over'));
    });
    row.addEventListener('dragover', (event) => { event.preventDefault(); row.classList.add('over'); });
    row.addEventListener('dragleave', () => row.classList.remove('over'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const target = Number(row.dataset.index);
      if (dragIndex === null || dragIndex === target) return;
      const [moved] = state.points.splice(dragIndex, 1);
      state.points.splice(target, 0, moved);
      dragIndex = null;
      invalidateComputed();
      render();
    });
  });
}

function renderMetrics() {
  const points = displayedPoints();
  const metres = routeDistanceMeters(points);
  const seconds = plannedSeconds();
  el.mDistance.textContent = points.length > 1 ? nm(metres) : '—';
  el.mDuration.textContent = points.length > 1 ? duration(seconds) : '—';
  el.mSpeedUnit.textContent = `${num(state.speedKnots, 1)} knot ile`;
  el.mArrival.textContent = points.length > 1 ? arrivalText(seconds) : '—';

  const last = points[points.length - 1];
  if (points.length > 1 && last) {
    const arrival = new Date(Date.now() + seconds * 1000);
    const sun = sunTimes(arrival, last.latitude, last.longitude);
    if (sun) {
      const dark = arrival > sun.sunset;
      el.mSun.textContent = `gun batimi ${clock(sun.sunset)}${dark ? ' · karanlikta varis' : ''}`;
      el.mSun.style.color = dark ? 'var(--orange)' : '';
      el.mSun.style.fontWeight = dark ? '700' : '';
    } else { el.mSun.textContent = '—'; el.mSun.style.color = ''; }
  } else { el.mSun.textContent = '—'; el.mSun.style.color = ''; }
}

function renderResult() {
  const computed = state.computed;
  el.resultBlock.hidden = !computed;
  el.gridButton.disabled = !computed;
  el.modeBadge.textContent = computed
    ? 'Derinlik ve engellere gore hesaplandi'
    : 'Elle cizim · derinlik kontrolu yok';
  el.modeBadge.classList.toggle('verified', !!computed);
  if (!computed) { el.legList.innerHTML = ''; return; }

  const unverified = unverifiedSegments();
  const unverifiedM = unverified.reduce((sum, [a, b]) => sum + distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude), 0);
  el.resultSummary.textContent = `${nm(computed.distanceM)} deniz mili dogrulandi · en sig model degeri `
    + `${num(computed.shallowestModelDepth, 1)} m (gereken ${num(computed.minimumDepth, 1)} m)`
    + (unverified.length ? ` · +${nm(unverifiedM)} nm dogrulanmamis` : '');
  el.unverifiedNote.hidden = !unverified.length;
  if (unverified.length) {
    const where = [state.unverifiedEnds.start ? 'baslangicta' : null, state.unverifiedEnds.end ? 'variste' : null]
      .filter(Boolean).join(' ve ');
    el.unverifiedNote.textContent = `Kirmizi kesikli parca (${where}, ${nm(unverifiedM)} nm) derinlik kontrolunden GECMEDI: `
      + 'model orayi cozemiyor. Bu parcayi gozle, haritayla ve iskandille seyredin.';
  }

  el.legList.innerHTML = '';
  computed.legs.forEach((leg, index) => {
    const row = document.createElement('div');
    row.className = 'leg-row';
    const left = document.createElement('span');
    left.textContent = `${index + 1}. ${leg.from} → ${leg.to}`;
    const right = document.createElement('b');
    right.textContent = `${nf(2).format(leg.gridDistanceM / 1852)} nm · ${leg.turns ?? '—'} donus · en sig ${num(leg.shallowestModelDepth, 1)} m`;
    row.append(left, right);
    el.legList.append(row);
  });
}

function renderProvenance() {
  const computed = state.computed;
  el.provenance.innerHTML = '';
  if (!computed) {
    el.provenance.innerHTML = '<p class="hint">Bir rota hesaplandiginda kaynak ayrintilari burada gorunur.</p>';
    return;
  }
  const p = computed.provenance;
  const when = (ms) => new Date(ms).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
  const rows = [
    ['Derinlik kaynagi', p.sourceLabel],
    ['Derinlik indirildi', `${when(p.bathymetryDownloadedAt)}${p.bathymetryFromCache ? ' (onbellek)' : ''}`],
    ['Engel verisi indirildi', `${when(p.osmDownloadedAt)}${p.osmFromCache ? ' (onbellek)' : ''}`],
    ['OSM veritabani tarihi', p.osmTimestamp],
    ['Hesap hucresi', `${p.cellMeters} m`],
    ['Grid', `${computed.bounds.columns} × ${computed.bounds.rows} hucre`],
    ['Kaynak grid adimi', `${(p.sourceLatitudeStep * 111194.9).toFixed(0)} m (${p.sourceLatitudeStep.toFixed(7)}°)`],
    ['Kiyi cizgisi', `${p.coastWays} yol · ${p.coastSegments} parca`],
    ['Karasulari siniri', p.boundaryChecked
      ? `${p.boundaryWays} yol · ${p.enforceOwnWaters ? 'rota kisiti acik' : 'yalnizca gosterim'}`
      : 'bu alanda sinir verisi yok'],
    ['Sinir disi hucre', `${p.foreignCellCount ?? 0} / ${p.totalCellCount}`],
    ['Engel geometrisi', String(p.obstacleCount)],
    ['Bilinmeyen hucre', `${p.unknownCellCount} / ${p.totalCellCount}`],
    ['Sig hucre', `${p.shallowCellCount} / ${p.totalCellCount}`],
    ['Yol hucresi', String(computed.pathCellCount)],
    ['Arama alani', p.widenedSearchArea ? `${p.margin}° (genisletildi)` : `${p.margin}°`],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'prov-row';
    const a = document.createElement('span'); a.textContent = label;
    const b = document.createElement('span'); b.textContent = value;
    row.append(a, b);
    el.provenance.append(row);
  }
  for (const [label, value] of [['Derinlik SHA-256', p.bathymetrySHA256], ['OSM SHA-256', p.osmSHA256]]) {
    const row = document.createElement('div');
    row.className = 'prov-row';
    const a = document.createElement('span'); a.textContent = label;
    const b = document.createElement('span'); b.className = 'prov-hash'; b.textContent = value;
    row.append(a, b);
    el.provenance.append(row);
  }
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = 'Kaynaklar bagimsiz dogrulama saglamaz: EMODnet modeli GEBCO dolgusu icerir ve bu surum '
    + 'hucre bazinda kaynak ayrimi yapmaz. Indirme tarihi, olcum tarihi degildir.';
  el.provenance.append(note);
}

function render() {
  renderPoints();
  renderMetrics();
  renderResult();
  renderProvenance();
  el.calcButton.disabled = state.points.length < 2 || state.busy;
  el.routeName.value = state.name;
  el.speed.value = String(state.speedKnots);
  el.speedOut.textContent = `${num(state.speedKnots, 1)} kn`;
  el.requiredDepth.textContent = `${num(
    state.boat.draft + state.boat.underKeel + state.boat.modelAllowance + state.boat.waterLevelDrop, 1)} m`;

  map.setPoints(state.points, { draggable: !state.tracking });
  map.setRoute(state.computed ? state.computed.points : state.points, { computed: !!state.computed });
  map.setUnverified(unverifiedSegments());
  el.hereStart.disabled = !!state.tracking;
  el.hereAdd.disabled = !!state.tracking;
  if (!state.computed) el.unverifiedNote.hidden = true;
}

// ------------------------------------------------------------------ tekne

function applyPreset(key) {
  const preset = BOAT_PRESETS[key];
  if (!preset) return;
  state.boat = pick(preset);
  store.saveBoat(state.boat);
  state.settings.boatPreset = key;
  store.saveSettings(state.settings);
  invalidateComputed();
  renderBoatFields();
  render();
}

el.boatPreset.addEventListener('change', () => {
  if (el.boatPreset.value === 'custom') {
    state.settings.boatPreset = 'custom';
    store.saveSettings(state.settings);
    return;
  }
  applyPreset(el.boatPreset.value);
});

function renderBoatFields() {
  el.boatPreset.value = state.settings.boatPreset ?? 'custom';
  el.boatFields.innerHTML = '';
  for (const field of BOAT_FIELDS) {
    const row = document.createElement('div');
    row.className = 'field-row';
    const label = document.createElement('div');
    label.className = 'f-label';
    label.innerHTML = `<b></b><span></span>`;
    label.querySelector('b').textContent = field.label;
    label.querySelector('span').textContent = field.hint;

    const stepper = document.createElement('div');
    stepper.className = 'stepper';
    const minus = document.createElement('button');
    minus.type = 'button'; minus.textContent = '−';
    const input = document.createElement('input');
    input.type = 'text'; input.inputMode = 'decimal';
    input.value = num(state.boat[field.key], field.step < 1 ? 1 : 0);
    const plus = document.createElement('button');
    plus.type = 'button'; plus.textContent = '+';

    const commit = (value) => {
      const clamped = Math.min(field.max, Math.max(field.min, Math.round(value / field.step) * field.step));
      state.boat[field.key] = Number(clamped.toFixed(3));
      store.saveBoat(state.boat);
      // Elle degistirilen olcu artik bir on ayar degil.
      state.settings.boatPreset = 'custom';
      store.saveSettings(state.settings);
      invalidateComputed();
      renderBoatFields();
      render();
    };
    minus.addEventListener('click', () => commit(state.boat[field.key] - field.step));
    plus.addEventListener('click', () => commit(state.boat[field.key] + field.step));
    input.addEventListener('change', () => {
      const value = Number(String(input.value).replace(',', '.'));
      if (Number.isFinite(value)) commit(value);
      else renderBoatFields();
    });

    stepper.append(minus, input, plus);
    const unit = document.createElement('span');
    unit.style.cssText = 'flex:none;font-size:13px;color:var(--muted);width:14px';
    unit.textContent = field.unit;
    row.append(label, stepper, unit);
    el.boatFields.append(row);
  }
}

// ------------------------------------------------------------------- hesap

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = (event) => {
    const message = event.data;
    if (message.type === 'progress') {
      el.progressText.textContent = message.text;
      el.progressFill.style.width = `${Math.round((message.fraction ?? 0.05) * 100)}%`;
      return;
    }
    if (message.type === 'done') {
      state.busy = false;
      el.progress.hidden = true;
      state.computed = {
        points: message.points,
        anchors: message.anchors,
        legs: message.legs,
        boat: message.boat,
        minimumDepth: message.minimumDepth,
        distanceM: message.distanceM,
        gridDistanceM: message.gridDistanceM,
        shallowestModelDepth: message.shallowestModelDepth,
        pathCellCount: message.pathCellCount,
        provenance: message.provenance,
        bounds: message.bounds,
        mask: message.mask,
        pass: message.pass,
        depths: message.depths,
        boundaryLines: message.boundaryLines ?? [],
        foreignCellCount: message.foreignCellCount ?? 0,
        boundaryChecked: message.boundaryChecked ?? false,
      };
      map.setBoundaries(message.boundaryLines);
      render();
      map.fit(displayedPoints());
      // Hesap bitince derinlik katmani kendiliginden acilir: sonucu okumanin
      // en hizli yolu, rotanin hangi renkten gectigini gormek.
      setGridMode('depth');
      return;
    }
    if (message.type === 'error') {
      state.busy = false;
      el.progress.hidden = true;
      if (!message.aborted) showCalcError(message);
      render();
    }
  };
  worker.onerror = (event) => {
    state.busy = false;
    el.progress.hidden = true;
    showCalcError({ message: `Hesap modulu yuklenemedi: ${event.message ?? 'bilinmeyen hata'}` });
    render();
  };
  return worker;
}

function showCalcError(message) {
  el.calcError.hidden = false;
  el.calcError.innerHTML = '';
  const text = document.createElement('div');
  text.textContent = message.message;
  el.calcError.append(text);

  const detail = message.detail;
  const fixes = document.createElement('div');
  fixes.className = 'fix';

  if (detail?.diagnosis?.nearest && detail.blocked) {
    const near = detail.diagnosis.nearest;
    const button = document.createElement('button');
    button.className = 'chip';
    button.type = 'button';
    button.textContent = `Onerilen noktayi haritada goster (${Math.round(near.distanceM)} m)`;
    button.addEventListener('click', () => {
      // Once haritada goster, sonra onay iste. Bir noktayi kilometrelerce
      // tasimak sessizce yapilacak bir sey degil: yanlis korfeze dusebilir.
      map.flyTo(near.latitude, near.longitude, 13);
      map.showSearchPin(near.latitude, near.longitude, 'Onerilen baslangic/varis');
      const bearing = Number.isFinite(near.bearingDeg) ? bearingText(near.bearingDeg) : '—';
      const water = near.waterPathM > near.distanceM * 1.3
        ? ` Deniz yoluyla yaklasik ${nm(near.waterPathM)} nm.` : '';
      confirmAction(
        `'${detail.blocked.name ?? 'Nokta'}' tasinsin mi?`,
        `Yeni yer haritada yildizla isaretlendi: ${near.latitude.toFixed(5)}, ${near.longitude.toFixed(5)} — `
        + `kus ucusu ${Math.round(near.distanceM)} m, ${bearing} yonunde.${water} `
        + 'Haritada dogru koyda oldugunu kontrol edin; yanlissa vazgecip noktayi elle tasiyin.',
        () => {
          const index = state.points.findIndex(p =>
            Math.abs(p.latitude - detail.blocked.latitude) < 1e-9 && Math.abs(p.longitude - detail.blocked.longitude) < 1e-9);
          if (index < 0) return;
          state.points[index] = {
            name: state.points[index].name,
            latitude: near.latitude,
            longitude: near.longitude,
          };
          map.clearSearchPin();
          el.calcError.hidden = true;
          render();
          calculate();
        });
    });
    fixes.append(button);
  }

  // Uc noktalarda ikinci secenek: gercek noktayi koru, rotayi en yakin uygun
  // sudan hesapla, aradaki parcayi DOGRULANMAMIS olarak ciz. Ara noktalarda
  // anlamsiz — oradan gecmek gerekir, gozle seyredilecek bir kiyi degil.
  if (detail?.diagnosis?.nearest && detail.blocked && state.points.length >= 2) {
    const anchors = effectiveAnchors();
    const same = (a, b) => Math.abs(a.latitude - b.latitude) < 1e-9 && Math.abs(a.longitude - b.longitude) < 1e-9;
    const isStart = same(anchors[0], detail.blocked);
    const isEnd = same(anchors[anchors.length - 1], detail.blocked);
    if (isStart || isEnd) {
      const near = detail.diagnosis.nearest;
      const button = document.createElement('button');
      button.className = 'chip danger';
      button.type = 'button';
      button.textContent = isStart ? 'Buradan dogrulanmamis etapla basla' : 'Buraya dogrulanmamis etapla var';
      button.addEventListener('click', () => {
        confirmAction(
          'Derinlik kontrolu olmayan parca eklensin mi?',
          `${isStart ? 'Baslangictan' : 'Varisa'} en yakin uygun suya kadar olan ${Math.round(near.distanceM)} m `
          + 'kirmizi kesikli cizilir ve mesafeye eklenir, ama derinlik ve engel acisindan DOGRULANMAZ. '
          + 'O parcayi gozle, haritayla ve iskandille seyretmeniz gerekir.',
          () => {
            if (isStart) state.unverifiedEnds.start = { latitude: near.latitude, longitude: near.longitude };
            else state.unverifiedEnds.end = { latitude: near.latitude, longitude: near.longitude };
            el.calcError.hidden = true;
            calculate();
          });
      });
      fixes.append(button);
    }
  }

  if (Number.isFinite(detail?.diagnosis?.usableBufferM) && detail.diagnosis.usableBufferM < state.boat.horizontalBuffer) {
    const button = document.createElement('button');
    button.className = 'chip';
    button.type = 'button';
    button.textContent = `Kiyi payini ${detail.diagnosis.usableBufferM} m yap`;
    button.addEventListener('click', () => {
      state.boat.horizontalBuffer = detail.diagnosis.usableBufferM;
      store.saveBoat(state.boat);
      el.calcError.hidden = true;
      renderBoatFields();
      render();
      calculate();
    });
    fixes.append(button);
  }

  if (detail?.gaps?.length) {
    const button = document.createElement('button');
    button.className = 'chip';
    button.type = 'button';
    button.textContent = 'Kopuk kiyiyi haritada goster';
    button.addEventListener('click', () => {
      map.flyTo(detail.gaps[0].latitude, detail.gaps[0].longitude, 15);
      map.showSearchPin(detail.gaps[0].latitude, detail.gaps[0].longitude, 'Kopuk kiyi cizgisi');
    });
    fixes.append(button);
  }

  if (fixes.childElementCount) el.calcError.append(fixes);
}

function calculate() {
  if (state.points.length < 2 || state.busy) return;
  state.busy = true;
  state.computed = null;
  setGridMode(null);
  el.calcError.hidden = true;
  el.progress.hidden = false;
  el.progressFill.style.width = '5%';
  el.progressText.textContent = 'Hazirlaniyor…';
  render();
  ensureWorker().postMessage({
    type: 'plan',
    anchors: effectiveAnchors(),
    boat: { ...state.boat },
    cellOverride: state.settings.resolution === 'auto' ? undefined : Number(state.settings.resolution),
    enforceOwnWaters: state.settings.ownWaters !== false,
  });
}

el.calcButton.addEventListener('click', calculate);
el.cancelButton.addEventListener('click', () => {
  worker?.postMessage({ type: 'cancel' });
  state.busy = false;
  el.progress.hidden = true;
  el.progressText.textContent = 'Iptal edildi';
  render();
});

// ---------------------------------------------------------------- seyir

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { wakeLock = null; }
}

function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* yoksay */ }
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.tracking && !wakeLock) requestWakeLock();
});

function usableFix(position) {
  if (!position) return null;
  const { coords, timestamp } = position;
  const age = Date.now() - timestamp;
  if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) return null;
  if (!Number.isFinite(coords.accuracy) || coords.accuracy > FIX_MAX_ACCURACY_M) return null;
  if (!(age >= -2000 && age <= FIX_MAX_AGE_MS)) return null;
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: coords.accuracy,
    speed: Number.isFinite(coords.speed) && coords.speed >= 0 ? coords.speed : NaN,
    heading: Number.isFinite(coords.heading) ? coords.heading : NaN,
    at: timestamp,
  };
}

function startWatching() {
  if (watchId !== null || !('geolocation' in navigator)) return;
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      state.position = usableFix(position);
      onPosition();
    },
    (error) => {
      state.position = null;
      el.gpsChip.classList.remove('live');
      el.gpsChip.textContent = error.code === error.PERMISSION_DENIED
        ? 'Konum izni kapali' : 'Konum alinamiyor';
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  );
}

const TRACK_MIN_METRES = 8;

/** Seyirdeyken her kullanilabilir konumu ize ekler; kipirdanmayi eler. */
function recordTrackPoint(fix) {
  const last = state.track[state.track.length - 1];
  if (last && distanceMeters(last.latitude, last.longitude, fix.latitude, fix.longitude) < TRACK_MIN_METRES) return;
  state.track.push({ latitude: fix.latitude, longitude: fix.longitude, at: fix.at, speed: fix.speed });
  if (state.track.length % 10 === 0) store.saveTrack(state.track);
  renderTrackButtons();
}

function renderTrackButtons() {
  const n = state.track.length;
  el.trackExport.hidden = n < 2;
  el.trackClear.hidden = n < 2;
  if (n >= 2) {
    const metres = routeDistanceMeters(state.track);
    el.trackExport.textContent = `Izi indir (${nm(metres)} nm)`;
  }
}

function onPosition() {
  const fix = state.position;
  if (fix && state.tracking) recordTrackPoint(fix);
  if (fix) {
    el.gpsChip.classList.add('live');
    el.gpsChip.textContent = `GPS ±${Math.ceil(fix.accuracy)} m`;
    map.setBoat(fix);
  } else {
    el.gpsChip.classList.remove('live');
    el.gpsChip.textContent = 'Yeterli dogrulukta GPS bekleniyor';
    map.setBoat(null);
  }
  if (fix && state.pendingHere && !state.tracking) {
    const action = state.pendingHere;
    state.pendingHere = null;
    if (action === 'start') useHereAsStart();
    else addPoint(currentPoint(`Konumum ${clock(new Date())}`));
  }
  if (state.tracking) renderTracking();
}

function cellAt(bounds, latitude, longitude) {
  const x = (longitude - bounds.west) * bounds.metersPerLongitudeDegree;
  const y = (latitude - bounds.south) * bounds.metersPerLatitudeDegree;
  if (!(x >= 0 && y >= 0 && x < bounds.columns * bounds.cell && y < bounds.rows * bounds.cell)) return -1;
  return (bounds.rows - 1 - Math.floor(y / bounds.cell)) * bounds.columns + Math.floor(x / bounds.cell);
}

function setAlert(text, level) {
  const key = `${level}:${text}`;
  if (state.lastAlert === key) return;
  state.lastAlert = key;
  if (!text) { el.alertStrip.hidden = true; return; }
  el.alertStrip.hidden = false;
  el.alertStrip.textContent = text;
  el.alertStrip.classList.toggle('warn', level === 'warn');
  if (navigator.vibrate) navigator.vibrate(level === 'danger' ? [200, 90, 200] : 140);
}

function startTracking() {
  if (!state.computed || displayedPoints().length < 2) return;
  state.tracking = { targetIndex: 1, startedAt: Date.now() };
  el.planView.hidden = true;
  el.trackView.hidden = false;
  el.panel.classList.remove('tall');
  requestWakeLock();
  render();
  renderTracking();
}

function stopTracking(silent) {
  if (!state.tracking) return;
  state.tracking = null;
  store.saveTrack(state.track);
  releaseWakeLock();
  el.planView.hidden = false;
  el.trackView.hidden = true;
  map.setGuidance(null, null);
  setAlert('', null);
  if (!silent) render();
}

function renderTracking() {
  const tracking = state.tracking;
  const computed = state.computed;
  if (!tracking || !computed) return;
  const points = displayedPoints();
  const index = Math.min(tracking.targetIndex, points.length - 1);
  const target = points[index];
  const previous = points[index - 1] ?? points[0];
  const fix = state.position;
  // Bu etap dogrulanmamis mi? Baslangictaki ilk parca ya da varistaki son parca.
  const onUnverifiedLeg = (state.unverifiedEnds.start && index === 1)
    || (state.unverifiedEnds.end && index === points.length - 1);

  el.trackTarget.textContent = `${index + 1}/${points.length} · ${target.name ?? 'Rota noktasi'}`
    + (onUnverifiedLeg ? ' · DOGRULANMAMIS' : '');

  if (!fix) {
    el.trackSub.textContent = 'Guncel ve yeterli dogruluklu GPS bekleniyor';
    for (const node of [el.tRemaining, el.tSpeed, el.tEta, el.tBearing, el.tXte, el.tDepth]) node.textContent = '—';
    el.tArrival.textContent = '—';
    el.tNext.disabled = true;
    map.setGuidance(null, null);
    return;
  }

  const toTarget = distanceMeters(fix.latitude, fix.longitude, target.latitude, target.longitude);
  let remaining = toTarget;
  for (let i = index; i + 1 < points.length; i++) {
    remaining += distanceMeters(points[i].latitude, points[i].longitude, points[i + 1].latitude, points[i + 1].longitude);
  }
  const bearing = initialBearingDeg(fix.latitude, fix.longitude, target.latitude, target.longitude);
  const knots = knotsFromMps(fix.speed);
  const seconds = Number.isFinite(knots) && knots >= 0.5 ? etaSeconds(remaining, fix.speed) : NaN;
  const xte = crossTrackMeters(fix.latitude, fix.longitude,
    previous.latitude, previous.longitude, target.latitude, target.longitude);

  el.trackSub.textContent = `Hedefe ${nm(toTarget)} nm · kerteriz ${bearingText(bearing)} gercek`;
  el.tRemaining.textContent = nm(remaining);
  el.tSpeed.textContent = num(knots, 1);
  el.tEta.textContent = duration(seconds);
  el.tArrival.textContent = Number.isFinite(seconds) ? `varis ${arrivalText(seconds)}` : 'hiz bekleniyor';
  el.tBearing.textContent = bearingText(bearing);
  el.tXte.textContent = Number.isFinite(xte) ? num(Math.abs(xte), 0) : '—';
  el.tXte.parentElement.classList.toggle('alarm', Number.isFinite(xte) && Math.abs(xte) > XTE_WARN_METRES);

  // Bulundugun hucre: karar tam hassasiyetle worker'da hesaplandi.
  const cell = cellAt(computed.bounds, fix.latitude, fix.longitude);
  const depth = cell >= 0 ? computed.depths[cell] : NaN;
  el.tDepth.textContent = Number.isFinite(depth) ? num(depth, 1) : '—';
  const passable = cell >= 0 ? computed.pass[cell] === 1 : null;
  el.tDepth.parentElement.classList.toggle('alarm', passable === false);

  if (onUnverifiedLeg) {
    setAlert('DOGRULANMAMIS ETAP — derinlik kontrolu yok, gozle ve iskandille seyredin', 'danger');
  } else if (passable === false) {
    const reason = cell >= 0 && !Number.isFinite(depth) ? 'DERINLIK BILINMIYOR' : 'SIG VEYA ENGELLI ALAN';
    setAlert(`${reason} — kontrol edilmis rotanin disindasiniz`, 'danger');
  } else if (Number.isFinite(xte) && Math.abs(xte) > XTE_WARN_METRES) {
    setAlert(`Rotadan ${num(Math.abs(xte), 0)} m sapma`, 'warn');
  } else if (cell < 0) {
    setAlert('Hesaplanan alanin disindasiniz', 'warn');
  } else {
    setAlert('', null);
  }

  map.setGuidance(fix, target);
  el.tNext.disabled = !(toTarget <= ADVANCE_METRES);
  el.tNext.textContent = index + 1 < points.length ? 'Noktaya ulastim →' : 'Varisa ulastim';

  // Yalnizca siradaki noktaya ilerler; uzak bir etaba atlamaz.
  if (toTarget <= ADVANCE_METRES) {
    if (index + 1 < points.length) tracking.targetIndex = index + 1;
    else { stopTracking(); setAlert('Planlanan varisa ulasildi', 'warn'); }
  }
}

el.trackButton.addEventListener('click', startTracking);
el.trackStop.addEventListener('click', () => confirmAction('Seyir takibi bitirilsin mi?', '', () => stopTracking()));
el.tNext.addEventListener('click', () => {
  const tracking = state.tracking;
  if (!tracking || !state.computed) return;
  if (tracking.targetIndex + 1 < displayedPoints().length) tracking.targetIndex++;
  else stopTracking();
  renderTracking();
});

// -------------------------------------------------------------- kontroller

el.speed.addEventListener('input', () => {
  state.speedKnots = Number(el.speed.value);
  el.speedOut.textContent = `${num(state.speedKnots, 1)} kn`;
  renderMetrics();
});

el.routeName.addEventListener('input', () => { state.name = el.routeName.value; });

el.reverse.addEventListener('click', () => {
  if (state.points.length < 2 || state.tracking) return;
  state.points.reverse();
  invalidateComputed();
  render();
});

el.clear.addEventListener('click', () => {
  if (!state.points.length) return;
  confirmAction('Rota temizlensin mi?', 'Kaydedilmemis noktalar silinir.', () => {
    state.points = [];
    invalidateComputed();
    state.name = 'Yeni rota';
    state.id = crypto.randomUUID();
    render();
  });
});

function currentPoint(name) {
  const fix = state.position;
  if (!fix) return null;
  return { name, latitude: fix.latitude, longitude: fix.longitude };
}

function useHereAsStart() {
  const here = currentPoint('Konumum');
  if (!here || state.tracking) return;
  // Ilk nokta zaten konum ise guncelle, degilse basa ekle.
  if (state.points[0]?.name === 'Konumum') state.points[0] = here;
  else state.points.unshift(here);
  invalidateComputed();
  render();
  map.fit(state.points.length > 1 ? state.points : [here]);
}

/** GPS henuz yoksa izin ister, bekler ve konum gelir gelmez islemi yapar. */
function whenLocated(action) {
  if (state.tracking) return;
  if (state.position) {
    if (action === 'start') useHereAsStart();
    else addPoint(currentPoint(`Konumum ${clock(new Date())}`));
    return;
  }
  state.pendingHere = action;
  startWatching();
  el.gpsChip.classList.remove('live');
  el.gpsChip.textContent = 'Konum bekleniyor — gelince eklenecek';
}

el.hereStart.addEventListener('click', () => whenLocated('start'));
el.hereAdd.addEventListener('click', () => whenLocated('add'));
// GPS cipine dokunmak da konumu baslangic yapar.
el.gpsChip.addEventListener('click', () => whenLocated('start'));
el.gpsChip.title = 'Konumumu baslangic yap';

el.locate.addEventListener('click', () => {
  startWatching();
  if (state.position) map.flyTo(state.position.latitude, state.position.longitude, 14);
});

el.fit.addEventListener('click', () => {
  const points = displayedPoints();
  map.fit(points.length ? points : (state.position ? [state.position] : []));
});

el.seamark.addEventListener('click', () => {
  state.settings.seamarks = !state.settings.seamarks;
  store.saveSettings(state.settings);
  el.seamark.classList.toggle('active', state.settings.seamarks);
  map.setSeamarks(state.settings.seamarks);
});

/** Katman: kapali -> derinlik bantlari -> hucre durumu -> kapali. */
function setGridMode(mode) {
  state.gridMode = mode;
  const c = state.computed;
  el.gridButton.classList.toggle('active', !!mode);
  el.gridButton.textContent = mode === 'cells' ? '\u25a6' : '\u224b';
  el.gridButton.title = mode === 'depth' ? 'Derinlik katmani (dokun: hucre durumu)'
    : mode === 'cells' ? 'Hucre durumu (dokun: kapat)' : 'Derinlik katmanini ac';
  el.legend.hidden = mode !== 'depth';
  if (!c || !mode) { map.setGrid(null); return; }
  map.setGrid({ bounds: c.bounds, mask: c.mask, depths: c.depths, required: c.minimumDepth }, mode);
}

el.gridButton.addEventListener('click', () => {
  if (!state.computed) return;
  setGridMode(state.gridMode === null ? 'depth' : state.gridMode === 'depth' ? 'cells' : null);
});

function renderLegend() {
  el.legendScale.innerHTML = '';
  for (const item of DEPTH_LEGEND) {
    const div = document.createElement('div');
    div.className = 'legend-item';
    const swatch = document.createElement('div');
    swatch.className = 'legend-swatch';
    swatch.style.background = item.colour;
    const label = document.createElement('div');
    label.className = 'legend-label';
    label.textContent = item.label;
    div.append(swatch, label);
    el.legendScale.append(div);
  }
}

el.ownWaters.addEventListener('change', () => {
  state.settings.ownWaters = el.ownWaters.checked;
  store.saveSettings(state.settings);
  invalidateComputed();
  render();
});

el.resolution.addEventListener('change', () => {
  state.settings.resolution = el.resolution.value;
  store.saveSettings(state.settings);
  invalidateComputed();
  render();
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-body').forEach(body => {
      body.hidden = body.dataset.panel !== tab.dataset.tab;
    });
  });
});

el.panelGrip.addEventListener('click', () => {
  el.panel.classList.toggle('tall');
  setTimeout(() => map.invalidate(), 220);
});

// ------------------------------------------------------------- kayit / GPX

el.save.addEventListener('click', () => {
  if (!state.points.length) return;
  const saved = store.saveRoute({
    id: state.id,
    name: state.name,
    savedAt: Date.now(),
    speedKnots: state.speedKnots,
    points: displayedPoints(),
    anchors: state.points,
    boat: state.boat,
    legs: state.computed?.legs ?? null,
    distanceM: state.computed?.distanceM ?? routeDistanceMeters(state.points),
    minimumDepth: state.computed?.minimumDepth ?? null,
    shallowestModelDepth: state.computed?.shallowestModelDepth ?? null,
    provenance: state.computed?.provenance ?? null,
  });
  el.save.textContent = saved ? 'Kaydedildi ✓' : 'Kaydedilemedi';
  setTimeout(() => { el.save.textContent = 'Kaydet'; }, 1800);
});

function renderRoutesDialog() {
  const rows = store.loadRoutes().sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  el.routesList.innerHTML = '';
  if (!rows.length) {
    el.routesList.innerHTML = '<p class="hint">Henuz kayitli rota yok.</p>';
    return;
  }
  for (const row of rows) {
    const card = document.createElement('div');
    card.className = 'route-card';
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'rc-main';
    const name = document.createElement('div');
    name.className = 'rc-name';
    name.textContent = row.name;
    const sub = document.createElement('div');
    sub.className = 'rc-sub';
    sub.textContent = `${row.points.length} nokta · ${nm(row.distanceM ?? 0)} nm`
      + (row.provenance ? ' · hesaplanmis' : ' · elle')
      + (row.savedAt ? ` · ${new Date(row.savedAt).toLocaleDateString('tr-TR')}` : '');
    main.append(name, sub);
    main.addEventListener('click', () => {
      state.id = row.id ?? crypto.randomUUID();
      state.name = row.name;
      state.points = (row.anchors ?? row.points).map(p => ({ ...p }));
      state.speedKnots = row.speedKnots ?? 5;
      if (row.boat) { state.boat = { ...DEFAULT_BOAT, ...row.boat }; renderBoatFields(); }
      state.computed = null;
      map.setGrid(null);
      el.routesDialog.close();
      render();
      map.fit(state.points);
    });
    const remove = document.createElement('button');
    remove.className = 'chip danger';
    remove.type = 'button';
    remove.textContent = 'Sil';
    remove.addEventListener('click', () => {
      store.deleteRoute(row.id);
      renderRoutesDialog();
    });
    card.append(main, remove);
    el.routesList.append(card);
  }
}

el.routes.addEventListener('click', () => { renderRoutesDialog(); el.routesDialog.showModal(); });

el.gpxExport.addEventListener('click', () => {
  if (!state.points.length) return;
  const unverified = unverifiedSegments();
  const unverifiedM = unverified.reduce((t, [a, b]) => t + distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude), 0);
  const route = state.computed
    ? {
        ...state.computed, points: displayedPoints(), name: state.name,
        unverifiedNote: unverified.length
          ? `${unverified.length} uc parca (${nm(unverifiedM)} nm) derinlik kontrolunden gecmedi.` : null,
      }
    : { name: state.name, points: state.points, boat: state.boat, provenance: null };
  const safe = state.name.replace(/[^\p{L}\p{N}\-_ ]/gu, '').trim().replace(/\s+/g, '-') || 'DenizRota';
  download(`${safe}.gpx`, routeToGPX(route));
});

el.trackExport.addEventListener('click', () => {
  if (state.track.length < 2) return;
  const started = new Date(state.track[0].at);
  const stamp = `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, '0')}-${String(started.getDate()).padStart(2, '0')}`;
  download(`DenizRota-iz-${stamp}.gpx`, routeToGPX({ name: `Iz ${stamp}`, points: [], provenance: null }, { track: state.track }));
});

el.trackClear.addEventListener('click', () => {
  confirmAction('Kayitli iz silinsin mi?', `${state.track.length} konum noktasi silinecek. Once indirmek isteyebilirsiniz.`, () => {
    state.track = [];
    store.saveTrack(state.track);
    renderTrackButtons();
  });
});

el.gpxImport.addEventListener('click', () => el.gpxFile.click());
el.gpxFile.addEventListener('change', async () => {
  const file = el.gpxFile.files?.[0];
  if (!file) return;
  try {
    const parsed = parseGPX(await file.text());
    state.name = parsed.name;
    state.points = parsed.points;
    state.id = crypto.randomUUID();
    invalidateComputed();
    render();
    map.fit(state.points);
  } catch (error) {
    showCalcError({ message: error.message });
  }
  el.gpxFile.value = '';
});

el.share.addEventListener('click', async () => {
  if (state.points.length < 2) return;
  const token = store.encodeRoute({
    name: state.name, speedKnots: state.speedKnots, boat: state.boat, anchors: state.points,
  });
  const url = `${location.origin}${location.pathname}#r=${token}`;
  try {
    if (navigator.share) await navigator.share({ title: state.name, url });
    else { await navigator.clipboard.writeText(url); el.share.textContent = 'Kopyalandi ✓'; }
  } catch { location.hash = `r=${token}`; }
  setTimeout(() => { el.share.textContent = 'Baglanti kopyala'; }, 1800);
});

// ------------------------------------------------------------------- menu

function confirmAction(title, text, onYes) {
  el.confirmTitle.textContent = title;
  el.confirmText.textContent = text;
  el.confirmDialog.showModal();
  const yes = () => { cleanup(); el.confirmDialog.close(); onYes(); };
  const no = () => { cleanup(); el.confirmDialog.close(); };
  const cleanup = () => {
    el.confirmYes.removeEventListener('click', yes);
    el.confirmNo.removeEventListener('click', no);
  };
  el.confirmYes.addEventListener('click', yes);
  el.confirmNo.addEventListener('click', no);
}

el.menuButton.addEventListener('click', () => el.menuDialog.showModal());
el.menuDialog.addEventListener('click', async (event) => {
  const action = event.target.dataset?.action;
  if (!action) return;
  el.menuDialog.close();
  if (action === 'new') el.clear.click();
  if (action === 'routes') { renderRoutesDialog(); el.routesDialog.showModal(); }
  if (action === 'about') el.aboutDialog.showModal();
  if (action === 'cache') {
    const { SourceCache } = await import('./cache.js');
    await new SourceCache().clear();
    el.cacheBadge.hidden = false;
    el.cacheBadge.textContent = 'Indirilen veri temizlendi';
    setTimeout(() => { el.cacheBadge.hidden = true; }, 3000);
  }
});

// ------------------------------------------------------------------ baslat

function loadFromHash() {
  const match = location.hash.match(/r=([A-Za-z0-9\-_]+)/);
  if (!match) return false;
  const decoded = store.decodeRoute(match[1]);
  if (!decoded) return false;
  state.name = decoded.name;
  state.points = decoded.anchors;
  state.speedKnots = decoded.speedKnots;
  if (decoded.boat) state.boat = { ...DEFAULT_BOAT, ...decoded.boat };
  history.replaceState(null, '', location.pathname);
  return true;
}

function init() {
  renderLegend();
  renderTrackButtons();
  el.resolution.value = state.settings.resolution;
  el.ownWaters.checked = state.settings.ownWaters !== false;
  el.seamark.classList.toggle('active', state.settings.seamarks);
  map.setSeamarks(state.settings.seamarks);
  renderBoatFields();

  const shared = loadFromHash();
  render();
  if (shared && state.points.length) {
    map.fit(state.points);
    el.calcError.hidden = false;
    el.calcError.textContent = 'Paylasilan rota yuklendi. Kendi tekne olculerinizle yeniden hesaplayin.';
  }

  startWatching();
  el.buildNote.textContent = new Date().getFullYear();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* cevrimdisi kabuk olmadan da calisir */ });
  }
  setTimeout(() => map.invalidate(), 250);
}

init();
