// Leaflet sarmalayici: taban harita, deniz isaretleri, rota, hesap alani katmani.
// Hesap gridi metrik esdikdortgensel; harita Mercator. Katman cizilirken satirlar
// Mercator'a yeniden orneklenir, yoksa renkli alan rotaya gore kayardi.

const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const SEAMARK_URL = 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png';

// Hucre durumu katmani: neyin neden kapali oldugunu gosterir.
const MASK_COLOURS = {
  0: [90, 90, 100, 150],   // bilinmiyor
  1: [0, 150, 160, 40],    // derinlik uygun
  2: [0, 0, 0, 0],         // kara (taban harita zaten gosteriyor)
  4: [210, 40, 50, 120],   // kiyi / engel
  8: [245, 145, 0, 130],   // sig
};

// Derinlik katmani: deniz haritasi mantigi — sig koyu, derin acik. Teknenin
// gecemeyecegi derinlik kirmizi, hemen ustundeki dar bant turuncu.
const DEPTH_BANDS = [
  { over: 60, colour: [232, 244, 251, 60] },
  { over: 30, colour: [176, 214, 238, 80] },
  { over: 15, colour: [116, 180, 220, 100] },
  { over: 5, colour: [56, 138, 196, 115] },
  { over: 0, colour: [26, 101, 163, 130] },
];
// Kiyi/engel ile sig su ayri kirmizilar: biri "burada kara/kaya var", digeri
// "su var ama teknene yetmez". Ikisi de gecilmez, ama denizci farki bilmek ister.
const OBSTACLE_COLOUR = [140, 26, 26, 135];
const UNSAFE_COLOUR = [214, 60, 52, 130];
const MARGINAL_COLOUR = [242, 155, 46, 135];
const UNKNOWN_COLOUR = [92, 92, 102, 150];

export const DEPTH_LEGEND = [
  { label: 'kiyi/engel', colour: 'rgb(140,26,26)' },
  { label: 'sig', colour: 'rgb(214,60,52)' },
  { label: 'sinirda', colour: 'rgb(242,155,46)' },
  { label: '+0 m', colour: 'rgb(26,101,163)' },
  { label: '+5 m', colour: 'rgb(56,138,196)' },
  { label: '+15 m', colour: 'rgb(116,180,220)' },
  { label: '+30 m', colour: 'rgb(176,214,238)' },
  { label: '+60 m', colour: 'rgb(232,244,251)' },
  { label: 'bilinmiyor', colour: 'rgb(92,92,102)' },
];

/** Renk, teknenin gereksiniminin USTUNDEKI paya gore secilir. */
function depthColour(depth, mask, required) {
  if (mask === 2) return [0, 0, 0, 0];
  if (mask === 4) return OBSTACLE_COLOUR;
  if (mask === 0 || !Number.isFinite(depth)) return UNKNOWN_COLOUR;
  if (depth < required) return UNSAFE_COLOUR;
  const spare = depth - required;
  if (spare < 2) return MARGINAL_COLOUR;
  for (const band of DEPTH_BANDS) if (spare > band.over) return band.colour;
  return DEPTH_BANDS[DEPTH_BANDS.length - 1].colour;
}

function mercatorY(latitude) {
  return Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
}
function inverseMercatorY(y) {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
}

export class MapView {
  constructor(elementId, { onMapClick, onMarkerDrag, onMarkerClick }) {
    this.map = L.map(elementId, {
      zoomControl: false,
      attributionControl: true,
      tap: true,
      worldCopyJump: true,
    }).setView([36.82, 27.7], 10);

    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(this.map);

    this.base = L.tileLayer(OSM_URL, {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkicilari',
    }).addTo(this.map);

    this.seamarks = L.tileLayer(SEAMARK_URL, {
      maxZoom: 18,
      opacity: 0.9,
      attribution: '<a href="https://www.openseamap.org/">OpenSeaMap</a> (CC BY-SA 2.0)',
    }).addTo(this.map);

    this.markers = [];
    this.routeLine = null;
    this.guidanceLine = null;
    this.boatMarker = null;
    this.accuracyCircle = null;
    this.gridOverlay = null;
    this.unverifiedLines = null;
    this.soundingLayer = null;
    this.soundingGrid = null;
    this.searchMarker = null;

    this.onMapClick = onMapClick;
    this.onMarkerDrag = onMarkerDrag;
    this.onMarkerClick = onMarkerClick;

    this.map.on('click', (event) => {
      if (this.suppressClick) return;
      this.onMapClick?.(event.latlng.lat, event.latlng.lng);
    });
  }

  get centre() {
    const c = this.map.getCenter();
    return { latitude: c.lat, longitude: c.lng };
  }

  setSeamarks(visible) {
    if (visible) this.seamarks.addTo(this.map);
    else this.map.removeLayer(this.seamarks);
  }

  flyTo(latitude, longitude, zoom) {
    this.map.setView([latitude, longitude], zoom ?? Math.max(this.map.getZoom(), 13), { animate: true });
  }

  showSearchPin(latitude, longitude, label) {
    this.clearSearchPin();
    this.searchMarker = L.marker([latitude, longitude], {
      icon: L.divIcon({ className: '', html: '<div class="wp-marker end">★</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
      zIndexOffset: 800,
    }).addTo(this.map);
    if (label) this.searchMarker.bindTooltip(label, { direction: 'top', offset: [0, -12] }).openTooltip();
  }

  clearSearchPin() {
    if (this.searchMarker) { this.map.removeLayer(this.searchMarker); this.searchMarker = null; }
  }

  /** Rota noktalari: surukle-birak ile tasinir, dokununca duzenlenir. */
  setPoints(points, { activeIndex = null, draggable = true } = {}) {
    for (const marker of this.markers) this.map.removeLayer(marker);
    this.markers = points.map((point, index) => {
      const last = index === points.length - 1;
      const classes = ['wp-marker', last ? 'end' : '', index === activeIndex ? 'active' : ''].filter(Boolean).join(' ');
      const marker = L.marker([point.latitude, point.longitude], {
        draggable,
        icon: L.divIcon({
          className: '',
          html: `<div class="${classes}">${index + 1}</div>`,
          iconSize: [26, 26], iconAnchor: [13, 13],
        }),
        zIndexOffset: 500 + index,
      }).addTo(this.map);
      marker.bindTooltip(point.name ?? `Nokta ${index + 1}`, { direction: 'top', offset: [0, -14] });
      marker.on('dragstart', () => { this.suppressClick = true; });
      marker.on('dragend', (event) => {
        const position = event.target.getLatLng();
        this.onMarkerDrag?.(index, position.lat, position.lng);
        setTimeout(() => { this.suppressClick = false; }, 60);
      });
      marker.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        this.onMarkerClick?.(index);
      });
      return marker;
    });
  }

  setRoute(points, { computed = false } = {}) {
    if (this.routeLine) { this.map.removeLayer(this.routeLine); this.routeLine = null; }
    if (points.length < 2) return;
    this.routeLine = L.polyline(points.map(p => [p.latitude, p.longitude]), {
      color: computed ? '#0a7d8c' : '#6b7d88',
      weight: computed ? 4 : 3,
      opacity: 0.95,
      dashArray: computed ? null : '8 6',
      lineJoin: 'round',
    }).addTo(this.map);
  }

  /** Derinlik kontrolu yapilmamis parcalar: kirmizi, kesikli, karistirilmaz. */
  setUnverified(segments) {
    if (this.unverifiedLines) { this.map.removeLayer(this.unverifiedLines); this.unverifiedLines = null; }
    if (!segments || !segments.length) return;
    this.unverifiedLines = L.layerGroup(segments.map(([a, b]) => L.polyline(
      [[a.latitude, a.longitude], [b.latitude, b.longitude]],
      { color: '#c0392b', weight: 4, dashArray: '4 8', opacity: 0.95, lineCap: 'butt' },
    ).bindTooltip('Dogrulanmamis etap — derinlik kontrolu yok', { sticky: true }))).addTo(this.map);
  }

  setGuidance(from, to) {
    if (this.guidanceLine) { this.map.removeLayer(this.guidanceLine); this.guidanceLine = null; }
    if (!from || !to) return;
    this.guidanceLine = L.polyline([[from.latitude, from.longitude], [to.latitude, to.longitude]], {
      color: '#c2560a', weight: 3, dashArray: '7 6', opacity: 0.95,
    }).addTo(this.map);
  }

  setBoat(position) {
    if (!position) {
      if (this.boatMarker) { this.map.removeLayer(this.boatMarker); this.boatMarker = null; }
      if (this.accuracyCircle) { this.map.removeLayer(this.accuracyCircle); this.accuracyCircle = null; }
      return;
    }
    const latlng = [position.latitude, position.longitude];
    if (!this.boatMarker) {
      this.boatMarker = L.marker(latlng, {
        icon: L.divIcon({ className: '', html: '<div class="boat-marker"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
        zIndexOffset: 1000, interactive: false,
      }).addTo(this.map);
    } else this.boatMarker.setLatLng(latlng);

    if (Number.isFinite(position.accuracy)) {
      if (!this.accuracyCircle) {
        this.accuracyCircle = L.circle(latlng, {
          radius: position.accuracy, color: '#1668d6', weight: 1, fillOpacity: 0.08, interactive: false,
        }).addTo(this.map);
      } else {
        this.accuracyCircle.setLatLng(latlng);
        this.accuracyCircle.setRadius(position.accuracy);
      }
    }
  }

  /**
   * Hesap alanini katman olarak gosterir.
   * mode 'depth' derinlik bantlari, 'cells' hucre durumu, null kapali.
   * Hesap gridi metrik esdikdortgensel, harita Mercator: satirlar yeniden orneklenir.
   */
  setGrid(grid, mode = 'depth') {
    if (this.gridOverlay) { this.map.removeLayer(this.gridOverlay); this.gridOverlay = null; }
    this.soundingGrid = null;
    this.refreshSoundings();
    if (!grid || !mode) return;
    const { bounds, mask, depths, required } = grid;
    const { rows, columns, north, south, west, east, cell, metersPerLatitudeDegree } = bounds;

    const canvas = document.createElement('canvas');
    canvas.width = columns;
    canvas.height = rows;
    const context = canvas.getContext('2d');
    const image = context.createImageData(columns, rows);
    const data = image.data;

    const topY = mercatorY(north), bottomY = mercatorY(south);
    for (let outRow = 0; outRow < rows; outRow++) {
      const y = topY + (outRow + 0.5) / rows * (bottomY - topY);
      const latitude = inverseMercatorY(y);
      let sourceRow = Math.floor((north - latitude) * metersPerLatitudeDegree / cell);
      if (sourceRow < 0) sourceRow = 0;
      if (sourceRow > rows - 1) sourceRow = rows - 1;
      const sourceBase = sourceRow * columns;
      const outBase = outRow * columns * 4;
      for (let col = 0; col < columns; col++) {
        const i = sourceBase + col;
        const colour = mode === 'depth'
          ? depthColour(depths ? depths[i] : NaN, mask[i], required)
          : (MASK_COLOURS[mask[i]] ?? MASK_COLOURS[0]);
        const offset = outBase + col * 4;
        data[offset] = colour[0];
        data[offset + 1] = colour[1];
        data[offset + 2] = colour[2];
        data[offset + 3] = colour[3];
      }
    }
    context.putImageData(image, 0, 0);
    this.gridOverlay = L.imageOverlay(canvas.toDataURL('image/png'), [[south, west], [north, east]], {
      opacity: 1, interactive: false, className: 'grid-overlay',
    }).addTo(this.map);

    if (mode === 'depth' && depths) {
      this.soundingGrid = grid;
      this.refreshSoundings();
    }
  }

  /**
   * Iskandil rakamlari: yakinlastirinca ekranda seyrek bir izgara uzerinde
   * derinlik degerleri yazilir. Deniz haritalarindaki nokta derinliklerin
   * karsiligi; katman rengi bandi, rakam kesin degeri verir.
   */
  refreshSoundings() {
    if (!this.soundingLayer) {
      this.soundingLayer = L.layerGroup().addTo(this.map);
      this.map.on('moveend zoomend', () => this.refreshSoundings());
    }
    this.soundingLayer.clearLayers();
    const grid = this.soundingGrid;
    if (!grid || this.map.getZoom() < 12) return;
    const { bounds, mask, depths } = grid;
    const size = this.map.getSize();
    const STEP = 76; // ekranda ~76 px araliklarla
    const seen = new Set();
    for (let py = 30; py < size.y - 20; py += STEP) {
      for (let px = 26; px < size.x - 26; px += STEP) {
        const ll = this.map.containerPointToLatLng([px, py]);
        const x = (ll.lng - bounds.west) * bounds.metersPerLongitudeDegree;
        const y = (ll.lat - bounds.south) * bounds.metersPerLatitudeDegree;
        if (!(x >= 0 && y >= 0 && x < bounds.columns * bounds.cell && y < bounds.rows * bounds.cell)) continue;
        const i = (bounds.rows - 1 - Math.floor(y / bounds.cell)) * bounds.columns + Math.floor(x / bounds.cell);
        if (seen.has(i)) continue;
        seen.add(i);
        if (mask[i] === 2) continue;
        const depth = depths[i];
        let text = '?';
        if (Number.isFinite(depth) && mask[i] !== 0) {
          if (depth <= 0.5) text = '0';
          else text = depth < 10 ? depth.toFixed(1).replace('.', ',') : String(Math.round(depth));
        }
        const unsafe = !Number.isFinite(depth) || depth < grid.required;
        this.soundingLayer.addLayer(L.marker(ll, {
          interactive: false,
          icon: L.divIcon({
            className: '',
            html: `<span class="sounding${unsafe ? ' unsafe' : ''}">${text}</span>`,
            iconSize: [30, 14], iconAnchor: [15, 7],
          }),
        }));
      }
    }
  }

  fit(points, padding = [40, 40]) {
    const usable = points.filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
    if (!usable.length) return;
    if (usable.length === 1) { this.flyTo(usable[0].latitude, usable[0].longitude, 14); return; }
    this.map.fitBounds(L.latLngBounds(usable.map(p => [p.latitude, p.longitude])), { padding });
  }

  invalidate() { this.map.invalidateSize(); }
}
