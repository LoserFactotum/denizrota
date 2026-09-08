// Leaflet sarmalayici: taban harita, deniz isaretleri, rota, hesap alani katmani.
// Hesap gridi metrik esdikdortgensel; harita Mercator. Katman cizilirken satirlar
// Mercator'a yeniden orneklenir, yoksa renkli alan rotaya gore kayardi.

const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const SEAMARK_URL = 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png';

const MASK_COLOURS = {
  0: [90, 90, 100, 150],   // bilinmiyor
  1: [0, 150, 160, 40],    // derinlik uygun
  2: [0, 0, 0, 0],         // kara (taban harita zaten gosteriyor)
  4: [210, 40, 50, 120],   // kiyi / engel
  8: [245, 145, 0, 130],   // sig
};

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

  /** Hesap alanini renkli katman olarak gosterir (Mercator'a yeniden orneklenir). */
  setGrid(grid) {
    if (this.gridOverlay) { this.map.removeLayer(this.gridOverlay); this.gridOverlay = null; }
    if (!grid) return;
    const { bounds, mask } = grid;
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
        const colour = MASK_COLOURS[mask[sourceBase + col]] ?? MASK_COLOURS[0];
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
  }

  fit(points, padding = [40, 40]) {
    const usable = points.filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
    if (!usable.length) return;
    if (usable.length === 1) { this.flyTo(usable[0].latitude, usable[0].longitude, 14); return; }
    this.map.fitBounds(L.latLngBounds(usable.map(p => [p.latitude, p.longitude])), { padding });
  }

  invalidate() { this.map.invalidateSize(); }
}
