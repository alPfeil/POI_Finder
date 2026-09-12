'use strict';

const BC_CHANNEL    = 'poi-cache-channel';
const IDB_NAME      = 'poi-area-cache';
const IDB_VERSION   = 3;
const IDB_STORE     = 'pois';
const IDB_AREAS     = 'cache_areas';
const IDB_PHOTOS    = 'photos';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

const OSM_FILTERS = [
  ['natural','peak'],['natural','volcano'],['waterway','waterfall'],
  ['natural','spring'],['natural','hot_spring'],['natural','cave_entrance'],
  ['natural','saddle'],['natural','arch'],['natural','geyser'],['natural','glacier'],
  ['natural','cliff'],
  ['tourism','viewpoint'],['tourism','attraction'],['tourism','artwork'],
  ['tourism','museum'],['tourism','alpine_hut'],['tourism','wilderness_hut'],
  ['tourism','camp_site'],['tourism','picnic_site'],['tourism','theme_park'],
  ['historic','ruins'],['historic','castle'],['historic','fort'],['historic','monument'],
  ['historic','memorial'],['historic','archaeological_site'],['historic','battlefield'],
  ['historic','mine'],['historic','wayside_shrine'],['historic','city_gate'],
  ['historic','tomb'],['historic','abbey'],['historic','manor'],['historic','lighthouse'],
  ['historic','tumulus'],['historic','stone_circle'],['historic','menhir'],
  ['man_made','lighthouse'],['man_made','windmill'],['man_made','watermill'],['man_made','tower'],
  ['man_made','cairn'],
  ['leisure','nature_reserve'],['leisure','park'],['leisure','garden'],
  ['leisure','bird_hide'],['leisure','wildlife_hide'],
  ['amenity','shelter'],['amenity','fountain'],['amenity','place_of_worship'],
  ['tourism','zoo'],
];

const OSM_TYPE_MAP = {
  peak:'summit', volcano:'summit', waterfall:'waterfall',
  spring:'spring', hot_spring:'spring', cave_entrance:'cave',
  saddle:'saddle', arch:'arch', geyser:'geyser', glacier:'glacier', cliff:'cliff',
  viewpoint:'viewpoint', attraction:'attraction', artwork:'artwork',
  museum:'museum', alpine_hut:'alpine_hut', wilderness_hut:'wilderness_hut',
  camp_site:'camp', picnic_site:'picnic', theme_park:'theme_park',
  ruins:'historic', castle:'historic', fort:'historic', monument:'historic',
  memorial:'historic', archaeological_site:'historic', battlefield:'historic',
  mine:'historic', wayside_shrine:'historic', city_gate:'historic',
  tomb:'historic', abbey:'historic', manor:'historic',
  tumulus:'prehistoric', stone_circle:'prehistoric', menhir:'prehistoric',
  lighthouse:'lighthouse', windmill:'tower', watermill:'tower', tower:'tower', cairn:'cairn',
  nature_reserve:'nature_reserve', park:'park', garden:'garden',
  bird_hide:'wildlife_hide', wildlife_hide:'wildlife_hide',
  shelter:'shelter', fountain:'fountain', place_of_worship:'church', zoo:'zoo',
};

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2-lat1)*r, dLng = (lng2-lng1)*r;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function osmToItem(el, cLat, cLng) {
  const tags = el.tags || {};
  let type = 'poi';
  for (const [k, v] of OSM_FILTERS) { if (tags[k] === v) { type = OSM_TYPE_MAP[v] || 'poi'; break; } }
  const name = tags.name || tags['name:en'] || tags['name:de'] || null;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) return null;
  const osmType = el.type === 'way' ? 'way' : el.type === 'relation' ? 'relation' : 'node';
  return {
    id: 'osm_' + osmType + '_' + el.id, type,
    name: name || type, hasName: !!name,
    lat, lng,
    distance_m: haversine(cLat, cLng, lat, lng),
    elevation: tags.ele ? parseInt(tags.ele) : null,
    osm_url: `https://www.openstreetmap.org/${osmType}/${el.id}`,
    gmaps_url: `https://maps.google.com/?q=${lat.toFixed(7)},${lng.toFixed(7)}`,
    wiki: tags.wikipedia || tags.wikidata || null,
  };
}

// ── IndexedDB ─────────────────────────────────────────────────────────────────
let _idb = null;
function openIdb() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const st = db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        st.createIndex('type', 'type', { unique: false });
      }
      if (!db.objectStoreNames.contains(IDB_AREAS)) {
        db.createObjectStore(IDB_AREAS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(IDB_PHOTOS)) {
        const ps = db.createObjectStore(IDB_PHOTOS, { keyPath: 'id', autoIncrement: true });
        ps.createIndex('poiId', 'poiId', { unique: false });
      }
    };
    req.onsuccess  = e => { _idb = e.target.result; resolve(_idb); };
    req.onerror    = () => reject(req.error);
  });
}

function idbPutAll(items) {
  return openIdb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    items.forEach(item => tx.objectStore(IDB_STORE).put(item));
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  }));
}

function idbPutArea(area) {
  return openIdb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_AREAS, 'readwrite');
    tx.objectStore(IDB_AREAS).put(area);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  }));
}

// ── Tile caching (offline map) ────────────────────────────────────────────────
const TILE_CACHE = 'poi-tiles-v1';

self.addEventListener('fetch', event => {
  const url = event.request.url;
  if (!url.includes('tile.openstreetmap.org')) return;
  event.respondWith(
    caches.open(TILE_CACHE).then(cache =>
      cache.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        }).catch(() => cached || new Response('', { status: 503 }));
      })
    )
  );
});

// ── Message handler ───────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'CACHE_AREA') {
    // event.waitUntil keeps the SW alive until the download finishes,
    // even if the user locks the screen or switches apps.
    event.waitUntil(doDownload(event.data));
  }
});

async function doDownload({ lat, lng, radius, batches }) {
  const bc = new BroadcastChannel(BC_CHANNEL);
  let newPois = [];
  let failed  = 0;
  let completed = 0;

  bc.postMessage({ type: 'CACHE_PROGRESS', completed: 0, total: batches.length });

  const parse = async res => {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    return (d.elements || []).map(el => osmToItem(el, lat, lng)).filter(Boolean);
  };

  const results = await Promise.allSettled(batches.map(async query => {
    const postOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    };
    try {
      let items;
      try {
        items = await Promise.any(OVERPASS_ENDPOINTS.map(ep =>
          fetch(ep, { ...postOpts, signal: AbortSignal.timeout(55000) }).then(parse)
        ));
      } catch {
        const targetUrl = OVERPASS_ENDPOINTS[0] + '?data=' + encodeURIComponent(query);
        items = await Promise.any([
          'https://corsproxy.io/?url=' + encodeURIComponent(targetUrl),
          'https://api.allorigins.win/raw?url=' + encodeURIComponent(targetUrl),
        ].map(u => fetch(u, { signal: AbortSignal.timeout(55000) }).then(parse)));
      }
      completed++;
      bc.postMessage({ type: 'CACHE_PROGRESS', completed, total: batches.length });
      return items;
    } catch {
      failed++;
      completed++;
      bc.postMessage({ type: 'CACHE_PROGRESS', completed, total: batches.length });
      return [];
    }
  }));

  results.forEach(r => { if (r.status === 'fulfilled') newPois = newPois.concat(r.value); });

  if (newPois.length > 0) await idbPutAll(newPois);

  const now = Date.now();
  await idbPutArea({ id: `${lat}_${lng}_${radius}`, lat, lng, radius, ts: now, count: newPois.length });

  bc.postMessage({ type: 'CACHE_DONE', count: newPois.length, failed, lat, lng, radius });

  // Pre-fetch map tiles so the map works offline too
  await prefetchTiles(lat, lng, radius, bc);

  bc.close();
}

// ── Tile pre-fetch ────────────────────────────────────────────────────────────
function _tileXY(lat, lng, z) {
  const x = Math.floor((lng + 180) / 360 * (1 << z));
  const lr = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * (1 << z));
  return { x, y };
}

async function prefetchTiles(lat, lng, radiusM, bc) {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  const urls = [];
  for (const z of [12, 13, 14, 15]) {
    const { x: x1, y: y1 } = _tileXY(lat + dLat, lng - dLng, z);
    const { x: x2, y: y2 } = _tileXY(lat - dLat, lng + dLng, z);
    for (let x = x1; x <= x2; x++)
      for (let y = y1; y <= y2; y++)
        urls.push(`https://a.tile.openstreetmap.org/${z}/${x}/${y}.png`);
  }
  bc.postMessage({ type: 'TILE_PREFETCH_START', total: urls.length });
  const cache = await caches.open(TILE_CACHE);
  let done = 0;
  for (let i = 0; i < urls.length; i += 16) {
    await Promise.allSettled(urls.slice(i, i + 16).map(async url => {
      if (await cache.match(url)) return;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (r?.ok) cache.put(url, r);
    }));
    done = Math.min(i + 16, urls.length);
    bc.postMessage({ type: 'TILE_PREFETCH_PROGRESS', done, total: urls.length });
  }
  bc.postMessage({ type: 'TILE_PREFETCH_DONE', total: urls.length });
}
