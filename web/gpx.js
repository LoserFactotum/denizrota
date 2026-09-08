// GPX 1.1 disa/ice aktarma. Cikti, kaynak ve sinirlari acikca yazar; baska bir
// cihaza aktarildiginda rotanin nasil uretildigi kaybolmaz.

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function routeToGPX(route) {
  const provenance = route.provenance;
  const description = provenance
    ? `Deneysel rota. EMODnet DTM (GEBCO dolgusu dahil) ve OpenStreetMap katkicilari (ODbL). `
      + `Su cekimi ${route.boat.draft} m, aranan model derinligi ${route.minimumDepth} m, `
      + `kiyi/engel payi ${route.boat.horizontalBuffer} m, hesap hucresi ${provenance.cellMeters} m. `
      + `Rotadaki en sig model degeri ${route.shallowestModelDepth?.toFixed(1)} m. Seyir garantisi degildir.`
    : 'Elle cizilen rota; derinlik ve engel kontrolu yapilmadi.';
  const points = route.points.map((p, i) => {
    const name = p.name && p.name !== 'Rota donusu' ? p.name : `Nokta ${i + 1}`;
    return `    <rtept lat="${p.latitude}" lon="${p.longitude}"><name>${escapeXml(name)}</name></rtept>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="DenizRota" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escapeXml(route.name ?? 'DenizRota')}</name>
    <desc>${escapeXml(description)}</desc>
  </metadata>
  <rte>
    <name>${escapeXml(route.name ?? 'DenizRota')}</name>
    <desc>${escapeXml(description)}</desc>
${points}
  </rte>
</gpx>`;
}

export function parseGPX(text) {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('GPX dosyasi okunamadi.');
  const nodes = [...document.querySelectorAll('rtept, trkpt, wpt')];
  if (!nodes.length) throw new Error('GPX dosyasinda rota noktasi bulunamadi.');
  const points = nodes.map((node, i) => {
    const latitude = Number(node.getAttribute('lat'));
    const longitude = Number(node.getAttribute('lon'));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('GPX noktasinda gecersiz koordinat.');
    return {
      name: node.querySelector('name')?.textContent?.trim() || `Nokta ${i + 1}`,
      latitude, longitude,
    };
  });
  const name = document.querySelector('metadata > name, rte > name, trk > name')?.textContent?.trim();
  return { name: name || 'GPX rotasi', points };
}

export function download(filename, text, type = 'application/gpx+xml') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
