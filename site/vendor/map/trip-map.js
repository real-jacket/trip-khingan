/*
 * TripMap - shared editorial roadbook map (MapLibre GL + self-hosted PMTiles). No build step.
 * Load maplibre-gl.js and pmtiles.js first, then this file, then call:
 *
 *   const tm = TripMap.create({
 *     container: '#map',                       // element or selector
 *     base: 'map/base.pmtiles',                // Protomaps (v4 schema) extract, relative to the page
 *     terrain: 'map/terrain.pmtiles',          // Mapterhorn terrarium-512 extract (optional)
 *     landcover: 'map/landcover.pmtiles',      // coloured ESA WorldCover raster from scripts/build-landcover.py (optional)
 *     reliefTint: false,                       // true: warm hypsometric tint from the terrain source, fades out above z10
 *     reliefRange: [0, 1800],                  // metres mapped to the tint ramp (per trip)
 *     landcoverFullZoom: 9,                    // highest zoom at which the landcover file covers the whole view (see the landcover-lo source); omit when no tier is narrower
 *     maxBounds: [w, s, e, n],                 // the wide base/landcover tier; keeps every view inside the built data
 *     routes: 'map/routes.geojson',            // url or FeatureCollection; properties {id,label,color}
 *     points: [{ id, name, lngLat: [lng, lat], kind: 'stop'|'photo'|'stay', label }],
 *     activeRoutes: ['main', 'south'],         // others are drawn at 30% opacity
 *     onPointClick(point, feature) {},         // fired for stops/photos/stays (not clusters)
 *     fitPadding: { top, right, bottom, left },// optional override of the overview padding
 *     errorText: '...',                        // shown if tiles fail to load
 *     maxZoom: 13,                             // default 13; the base file may end below it (tiles overzoom past the file's last zoom)
 *     baseFullZoom: 12,                        // optional: highest zoom at which the base file covers the whole view; roads/water/labels overzoom from it, buildings and POIs come from the detailed tiles beyond it
 *     terrainFullZoom: 10,                     // optional: highest zoom at which the terrain file covers the whole view; hillshade is overzoomed from it so a narrower tier leaves no unshaded gaps
 *     clusterMaxZoom: 11,                      // optional: highest zoom at which nearby points are merged into a count
 *     mergeClusters: false,                    // true: stops and photo spots share one cluster source (no cross-kind overlap)
 *     fitButton: true,                         // built-in "全景" button (false if the page has its own)
 *     detail: 'https://tiles.openfreemap.org/planet', // optional TileJSON of an online OpenMapTiles vector source; from detailFromZoom up it replaces the self-hosted roads/names/POIs/buildings/boundaries (see "Online detail")
 *     detailFromZoom: 11,                      // zoom at which the online detail takes over (default 11)
 *     detailMaxZoom: 16,                       // max zoom while detail is active (default 16, never below maxZoom)
 *   });
 *   tm.map                    // the maplibregl.Map
 *   tm.ready                  // Promise resolved on first style load
 *   tm.setPoints(points)      // replace all points (e.g. when a route variant adds a stop)
 *   tm.setActiveRoute(ids)    // highlight these route ids
 *   tm.setRoutes(featureCollection) // replace the drawn routes (e.g. recolour per plan); feature.properties.color is a palette index
 *   tm.focusPoint(id, { context: [ids], padding, maxZoom, fly: false })  // mark active, fly to it (+ neighbours) unless fly:false
 *   tm.clearFocus()
 *   tm.fitTo([[lng,lat],...], { padding, maxZoom })
 *   tm.fitAll()               // fit the active routes (or all points)
 *   tm.destroy()
 *
 * AMap segmented navigation (standard for every roadbook; works without a map instance):
 *   TripMap.navSegments(stops)        // stops: [{ name, lngLat: [lng, lat] (WGS-84) }]
 *                                     // -> [{ part: 1.., stops: [2-3 stops] }], step 2, max 3 points per segment
 *   TripMap.amapRoute(stops, src)     // 2-3 stops -> https://uri.amap.com/navigation?from=..&to=..&mode=car&policy=0&callnative=1&src=..[&via=..]
 *                                     // coordinates are converted WGS-84 -> GCJ-02 (same algorithm as the Anhui roadbook)
 *   TripMap.wgs84ToGcj02(lng, lat)    // -> [lng, lat]
 *
 * Online detail: when opts.detail is set the TileJSON is probed once (4 s timeout). On success the detail layers (ids d-*) are added from detailFromZoom up and the self-hosted vector
 * layers are capped just below it, so nothing is drawn twice; land cover, hillshade, routes and markers always stay self-hosted. If the probe fails, or the online tiles keep failing, the
 * detail layers are removed and the self-hosted layers restored (offline rendering, offline max zoom). Without opts.detail nothing online is requested.
 * Returns null (and calls opts.onUnsupported) when WebGL is unavailable.
 * TripMap.renderLegend(el)   // fills el with the land-cover / road / boundary legend (Chinese, styles in trip-map.css)
 * All coordinates are WGS-84. Admin boundaries are province/prefecture/county only; country, disputed and maritime lines are never drawn.
 */
(function () {
  'use strict';
  var ROOT = (document.currentScript && document.currentScript.src || location.href).replace(/[^/]*$/, '');
  var PALETTE = ['#263c31', '#97502e', '#c08a3e', '#4f6f5c', '#7a4a62'];
  var KIND_COLOR = { stop: '#263c31', photo: '#97502e', stay: '#c08a3e' };
  var PAPER = '#fffdf8';
  var CJK_FONT = "'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC',sans-serif";
  var HAN = ['==', ['get', 'script'], 'Han']; // only Han-script labels are shown (no Mongolian/Cyrillic/Latin names)
  var REG = ['Noto Sans Regular'], MED = ['Noto Sans Medium'];
  var protocolReady = false;

  function z(stops) { return ['interpolate', ['linear'], ['zoom']].concat(stops); }
  function absolute(url) { return new URL(url, location.href).href; }

  function webglOk() {
    try { var c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
  }

  // Land-cover palette: the same hex values are baked into map/landcover.pmtiles by scripts/build-landcover.py (the legend reads them from here).
  var LC = { forest: '#b5c79e', shrub: '#cbd5ac', grass: '#dde2b6', farm: '#efe2b2', built: '#d9bfae', bare: '#e5dac6', water: '#b7cdcf', wetland: '#c3d7c9' };
  var ROAD = { hw: '#b9875f', nat: '#c99a6e', cty: '#d8c3a2' };
  var BOUNDARY = '#9b8a9a';
  // road widths per tier, shared by the self-hosted and the online detail layers so the switch at detailFromZoom has no jump
  var RW = { minor: [12, 0.6, 14, 1.4, 18, 5], path: [12, 0.5, 14, 0.9, 18, 2], cty: [9, 0.6, 12, 1, 14, 1.9, 18, 6], nat: [6, 0.6, 8, 1, 14, 2.6, 18, 8], hw: [5, 0.7, 8, 1.4, 14, 3.4, 18, 10] };
  var wide = function (stops, add) { return z(stops.map(function (v, i) { return i % 2 ? v + add : v; })); };

  function buildStyle(opts) {
    var sources = {
      base: { type: 'vector', url: 'pmtiles://' + absolute(opts.base), attribution: '' }
    };
    // MapLibre does not fall back to a parent tile for a vector tile that is missing either (it draws it empty), so when the file holds z13+ only along the route,
    // `base` is capped at baseFullZoom (everything overzooms from there) and a second source of the same file feeds only the layers that exist solely in the detailed tiles.
    var hiSrc = 'base';
    if (opts.baseFullZoom) {
      sources.base.maxzoom = opts.baseFullZoom;
      sources['base-detail'] = { type: 'vector', url: 'pmtiles://' + absolute(opts.base), minzoom: opts.baseFullZoom + 1, attribution: '' };
      hiSrc = 'base-detail';
    }
    if (opts.terrain) sources.terrain = { type: 'raster-dem', url: 'pmtiles://' + absolute(opts.terrain), encoding: 'terrarium', tileSize: 512, attribution: '' };
    if (opts.terrain && opts.terrainFullZoom) sources.terrain.maxzoom = opts.terrainFullZoom;
    if (opts.landcover) {
      sources.landcover = { type: 'raster', url: 'pmtiles://' + absolute(opts.landcover), tileSize: 512, attribution: '' };
      // MapLibre does not fall back to a parent tile for a raster tile that is missing: a second source of the same file, capped at the zoom where the file has no gaps, is drawn beneath so a z12+ tile outside the detailed tier shows overzoomed land cover instead of paper.
      if (opts.landcoverFullZoom) sources['landcover-lo'] = { type: 'raster', url: 'pmtiles://' + absolute(opts.landcover), tileSize: 512, maxzoom: opts.landcoverFullZoom, attribution: '' };
    }
    var L = [];
    var poly = ['==', ['geometry-type'], 'Polygon'];
    var line = ['==', ['geometry-type'], 'LineString'];
    var kind = ['get', 'kind'], detail = ['get', 'kind_detail'];
    var inList = function (v, list) { return ['in', v, ['literal', list]]; };
    L.push({ id: 'bg', type: 'background', paint: { 'background-color': '#f3eee1' } });
    L.push({ id: 'earth', type: 'fill', source: 'base', 'source-layer': 'earth', paint: { 'fill-color': '#f3eee1' } });
    if (opts.landcover) {
      if (opts.landcoverFullZoom) L.push({ id: 'landcover-lo', type: 'raster', source: 'landcover-lo', paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0 } });
      L.push({ id: 'landcover', type: 'raster', source: 'landcover', paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0 } });
    } else { // no raster built for this trip: fall back to the faint OSM landcover tint
      L.push({ id: 'landcover', type: 'fill', source: 'base', 'source-layer': 'landcover', paint: { 'fill-color': ['match', kind, ['forest', 'wood'], '#e4e8d6', 'farmland', '#efe9d8', ['urban_area'], '#ebe3cf', 'rgba(0,0,0,0)'] } });
    }
    if (opts.terrain && opts.reliefTint) {
      // optional hypsometric tint: warm ramp over [min, max] metres, faded out above z10 where the land cover takes over
      var r = Array.isArray(opts.reliefRange) ? opts.reliefRange : [0, 1800], ramp = ['#d3dcc0', '#e3dfb9', '#dfcfa4', '#cdb08a'], stops = [];
      ramp.forEach(function (c, i) { stops.push(r[0] + (r[1] - r[0]) * i / (ramp.length - 1), c); });
      L.push({ id: 'relief-tint', type: 'color-relief', source: 'terrain', paint: {
        'color-relief-color': ['interpolate', ['linear'], ['elevation']].concat(stops), 'color-relief-opacity': z([6, 0.55, 9, 0.45, 11, 0]) } });
    }
    if (opts.terrain) {
      L.push({ id: 'hillshade', type: 'hillshade', source: 'terrain', paint: {
        'hillshade-shadow-color': '#2c3e33', 'hillshade-highlight-color': 'rgba(255,253,248,0.5)', 'hillshade-accent-color': 'rgba(0,0,0,0)',
        'hillshade-exaggeration': z([5, 0.3, 10, 0.3, 12, 0.22, 13, 0.18]), 'hillshade-illumination-direction': 315 } });
    }
    // OSM landuse only where it adds precision to the 10 m raster: built-up edges from z11, protected areas as an outline
    L.push({ id: 'landuse-built', type: 'fill', source: 'base', 'source-layer': 'landuse', minzoom: 11, filter: ['all', poly, inList(kind, ['residential', 'industrial', 'commercial', 'retail', 'aerodrome'])], paint: {
      'fill-color': '#dcc3ad', 'fill-opacity': z([11, 0.55, 13, 0.8]) } });
    L.push({ id: 'landuse-park', type: 'line', source: 'base', 'source-layer': 'landuse', minzoom: 9, filter: ['all', poly, inList(kind, ['park', 'national_park', 'nature_reserve', 'protected_area'])], paint: {
      'line-color': '#7f9a78', 'line-width': 0.9, 'line-dasharray': [4, 2], 'line-opacity': 0.8 } });
    L.push({ id: 'buildings', type: 'fill', source: hiSrc, 'source-layer': 'buildings', minzoom: 14, filter: ['all', poly, ['==', kind, 'building']], paint: {
      'fill-color': '#e2d6c0', 'fill-opacity': z([14, 0, 15, 0.75]), 'fill-outline-color': '#cdbfa5' } });
    L.push({ id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', filter: poly, paint: { 'fill-color': '#b1c9cc' } });
    L.push({ id: 'river', type: 'line', source: 'base', 'source-layer': 'water', filter: line, paint: {
      'line-color': '#97b6bb', 'line-width': (function (r) { return z([6, r(0.8, 0.4), 12, r(2.2, 0.9), 14, r(3, 1.2)]); })(function (big, small) { return ['match', detail, ['river', 'canal'], big, small]; }) } });
    L.push({ id: 'rail', type: 'line', source: 'base', 'source-layer': 'roads', minzoom: 8, filter: ['all', line, ['==', kind, 'rail']], paint: {
      'line-color': '#8c8a7a', 'line-width': 1, 'line-dasharray': [6, 4] } });
    // four road tiers (casing under line). Protomaps: highway/motorway; major_road trunk+primary; major_road secondary+tertiary; minor_road, path/track
    var road = function (id, filter, color, stops, minzoom, casing) {
      var f = ['all', line, filter];
      if (casing) L.push({ id: id + '-casing', type: 'line', source: 'base', 'source-layer': 'roads', minzoom: minzoom, filter: f, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
        'line-color': '#fbf7ec', 'line-opacity': 0.85, 'line-width': wide(stops, casing) } });
      L.push({ id: id, type: 'line', source: 'base', 'source-layer': 'roads', minzoom: minzoom, filter: f, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': color, 'line-width': wide(stops, 0) } });
      return L[L.length - 1];
    };
    var NAT = ['trunk', 'trunk_link', 'primary', 'primary_link'], CTY = ['secondary', 'secondary_link', 'tertiary', 'tertiary_link'];
    var major = ['==', kind, 'major_road'];
    road('road-minor', ['any', ['==', kind, 'minor_road'], ['all', major, ['!', inList(detail, NAT.concat(CTY))]]], '#e0d2b8', RW.minor, 12);
    road('road-path', ['==', kind, 'path'], '#a8987c', RW.path, 12).paint['line-dasharray'] = [3, 2];
    road('road-county', ['all', major, inList(detail, CTY)], ROAD.cty, RW.cty, 9, 1.2);
    road('road-national', ['all', major, inList(detail, NAT)], ROAD.nat, RW.nat, 6, 1.2);
    road('road-expressway', ['==', kind, 'highway'], ROAD.hw, RW.hw, 5, 1.2);
    // admin boundaries: province 4, prefecture 5, county 6 only; never country (2), disputed or maritime lines
    var bnd = function (id, level, width, dash, minzoom) {
      L.push({ id: id, type: 'line', source: 'base', 'source-layer': 'boundaries', minzoom: minzoom, filter: ['all', line, ['==', detail, level], ['!=', kind, 'country'],
        ['!', ['to-boolean', ['get', 'disputed']]], ['!', ['to-boolean', ['get', 'maritime']]]],
        layout: { 'line-join': 'round' }, paint: { 'line-color': BOUNDARY, 'line-width': width, 'line-dasharray': dash, 'line-opacity': 0.9 } });
    };
    bnd('boundary-county', 6, 0.6, [2, 2], 9);
    bnd('boundary-prefecture', 5, 0.9, [3, 2], 6);
    bnd('boundary-province', 4, 1.2, [4, 2], 4);
    // routes: casing + colored line (source added in create())
    L.push({ id: 'route-casing', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
      'line-color': PAPER, 'line-width': z([5, 5, 12, 8]), 'line-opacity': 0.3 } });
    L.push({ id: 'route-line', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
      'line-color': ['to-color', ['at', ['coalesce', ['get', 'color'], 0], ['literal', PALETTE]]], 'line-width': z([5, 2.8, 12, 4.5]), 'line-opacity': 0.3 } });
    L.push({ id: 'route-dir', type: 'symbol', source: 'routes', minzoom: 7, layout: {
      'symbol-placement': 'line', 'symbol-spacing': 110, 'text-field': '>', 'text-font': MED, 'text-size': 12, 'text-keep-upright': false, 'text-rotation-alignment': 'map', 'text-allow-overlap': true }, paint: {
      'text-color': PAPER, 'text-opacity': 0.9 } });
    // labels
    var label = function (id, props) { L.push(Object.assign({ id: id, type: 'symbol', source: 'base' }, props)); };
    label('label-river', { 'source-layer': 'water', minzoom: 9, filter: ['all', line, HAN], layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': REG, 'text-size': 11 },
      paint: { 'text-color': '#4f7a78', 'text-halo-color': '#e4eae3', 'text-halo-width': 1.2 } });
    label('label-water', { 'source-layer': 'water', minzoom: 8, filter: ['all', ['!=', ['geometry-type'], 'LineString'], HAN], layout: { 'text-field': ['get', 'name'], 'text-font': REG, 'text-size': 12, 'text-letter-spacing': 0.1, 'text-max-width': 6 },
      paint: { 'text-color': '#4f7a78', 'text-halo-color': '#e4eae3', 'text-halo-width': 1.2 } });
    // street names (Han only), then travel POIs as a small dot + name; both sit below the place names and stop markers so those win collisions
    var roadName = function (id, kinds, minzoom, size) {
      label(id, { 'source-layer': 'roads', minzoom: minzoom, filter: ['all', line, HAN, inList(kind, kinds)], layout: { 'symbol-placement': 'line', 'symbol-spacing': 280, 'text-field': ['get', 'name'], 'text-font': REG, 'text-size': size, 'text-max-angle': 30, 'text-padding': 4 },
        paint: { 'text-color': '#7a6a52', 'text-halo-color': '#f5f2e9', 'text-halo-width': 1.4 } });
    };
    roadName('label-road-major', ['major_road'], 13, 10.5);
    roadName('label-road-minor', ['minor_road'], 14, 10);
    var poi = function (id, kinds, minzoom, image, color, sort) {
      label(id, { source: hiSrc, 'source-layer': 'pois', minzoom: minzoom, filter: ['all', ['==', ['geometry-type'], 'Point'], HAN, inList(kind, kinds)], layout: {
        'icon-image': image, 'text-field': ['get', 'name'], 'text-font': REG, 'text-size': 10.5, 'text-optional': true, 'text-padding': 3, 'icon-padding': 4, 'text-max-width': 7,
        'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 0.7, 'symbol-sort-key': sort },
        paint: { 'text-color': color, 'text-halo-color': '#f5f2e9', 'text-halo-width': 1.5 } });
    };
    poi('poi-service', ['parking', 'fuel', 'hotel', 'services', 'rest_area', 'bus_station'], 14, 'tm-poi-svc', '#8b7a5e', 3);
    poi('poi-scenic', ['attraction', 'viewpoint', 'museum', 'theme_park', 'park', 'place_of_worship', 'religious', 'peak'], 13, 'tm-poi', '#58765f',
      ['match', kind, ['attraction', 'viewpoint'], 0, ['museum', 'theme_park', 'park'], 1, ['place_of_worship', 'religious'], 2, 4]);
    // G/S route numbers in a paper box along the road; compound refs ("G233;S207") read "G233 S207"
    var ref = ['to-string', ['get', 'ref']], semi = ['index-of', ';', ref];
    label('label-road-ref', { 'source-layer': 'roads', minzoom: 9, filter: ['all', line, ['has', 'ref'], inList(kind, ['highway', 'major_road']), inList(['slice', ref, 0, 1], ['G', 'S'])], layout: {
      'symbol-placement': 'line', 'symbol-spacing': 420, 'text-field': ['case', ['>=', semi, 0], ['concat', ['slice', ref, 0, semi], ' ', ['slice', ref, ['+', semi, 1]]], ref],
      'text-font': MED, 'text-size': 10, 'text-padding': 8, 'text-max-angle': 25, 'icon-image': 'tm-ref', 'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 4, 1, 4], 'icon-rotation-alignment': 'map' },
      paint: { 'text-color': ['case', ['==', kind, 'highway'], '#7a4f2e', '#8a6a4a'] } });
    // admin names: provinces (letter-spaced, z5-7), then cities/towns/villages; label sits beside a stop marker (radial offset clears it) and flips before it would hide
    label('label-province', { 'source-layer': 'places', minzoom: 5, maxzoom: 8, filter: ['all', ['==', kind, 'region'], HAN], layout: { 'text-field': ['get', 'name'], 'text-font': REG, 'text-size': 13, 'text-letter-spacing': 0.35, 'text-max-width': 6 },
      paint: { 'text-color': '#7d6f7c', 'text-halo-color': '#f5f2e9', 'text-halo-width': 1.4 } });
    var place = function (id, kd, size, color, minzoom, maxzoom, font) {
      label(id, { 'source-layer': 'places', minzoom: minzoom, maxzoom: maxzoom || 24, filter: ['all', ['==', kind, 'locality'], ['==', detail, kd], HAN],
        layout: { 'text-field': ['get', 'name'], 'text-font': font || REG, 'text-size': size, 'text-padding': 4, 'text-max-width': 8, 'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 22 / size, 'text-justify': 'auto' },
        paint: { 'text-color': color, 'text-halo-color': '#f5f2e9', 'text-halo-width': 1.6 } });
    };
    place('label-hamlet', 'hamlet', 10.5, '#6b7a6c', 13);
    place('label-village', 'village', 11, '#5f6f61', 12);
    place('label-town', 'town', 12.5, '#33493d', 7);
    place('label-city', 'city', 15, '#203d30', 4, 24, MED);
    label('label-transit', { 'source-layer': 'pois', minzoom: 11, filter: ['all', ['in', kind, ['literal', ['aerodrome', 'station', 'train_station']]], HAN], layout: {
      'text-field': ['get', 'name'], 'text-font': REG, 'text-size': 10.5 },
      paint: { 'text-color': '#6b7a6c', 'text-halo-color': '#f5f2e9', 'text-halo-width': 1.4 } });
    return { version: 8, glyphs: ROOT + 'fonts/{fontstack}/{range}.pbf', sources: sources, layers: L };
  }

  // Online detail layers (OpenMapTiles schema, source 'detail'): the same palette, widths and label rules as the self-hosted layers above, so the switch at `from` is seamless.
  // `under` goes beneath the routes, `over` (labels) beneath the point markers. Compliance: boundaries are admin_level 4-6 only and never disputed/maritime; country/state labels are never added.
  var POI_SERVICE = ['parking', 'fuel', 'lodging', 'toilets', 'charging_station', 'shelter', 'information', 'campsite'];
  var POI_SCENIC = ['attraction', 'viewpoint', 'museum', 'theme_park', 'zoo', 'park', 'place_of_worship', 'religious', 'castle', 'monument', 'garden'];
  function detailLayers(from) {
    var DS = 'detail', up = function (m) { return Math.max(m, from); };
    var cls = ['get', 'class'], sub = ['get', 'subclass'];
    var line = ['==', ['geometry-type'], 'LineString'], poly = ['==', ['geometry-type'], 'Polygon'];
    var inList = function (v, list) { return ['in', v, ['literal', list]]; };
    // Han labels only: the first character of the name (or of name:zh) lies in U+4E00..U+9FFF; JS string order makes this a plain comparison
    var head = function (v) { var h = ['slice', ['to-string', v], 0, 1]; return ['all', ['>=', h, '\u4e00'], ['<=', h, '\u9fff']]; };
    var nm = ['get', 'name'], zh = ['coalesce', ['get', 'name:zh-Hans'], ['get', 'name:zh']];
    var HANN = ['any', head(nm), head(zh)];
    // OSM China names often read "满洲里市 ᠮᠠᠨᠵᠤᠤᠷ" (Han + Mongolian): keep the text before the first space, the glyph PBFs only cover Han
    var cut = function (v) { var t = ['to-string', v], i = ['index-of', ' ', t]; return ['slice', t, 0, ['case', ['>=', i, 0], i, ['length', t]]]; };
    var NAME = ['case', head(nm), cut(nm), cut(zh)];
    var under = [], over = [];
    var add = function (list, id, type, layer, props) { list.push(Object.assign({ id: 'd-' + id, type: type, source: DS, 'source-layer': layer }, props)); };
    // land cover polygons repaint the 10 m raster with crisp edges once zoomed in
    add(under, 'landcover', 'fill', 'landcover', { minzoom: 13, paint: { 'fill-opacity': z([13, 0, 14, 1]), 'fill-color': ['match', cls, 'wood', LC.forest, 'grass', LC.grass, 'farmland', LC.farm, 'wetland', LC.wetland, ['sand', 'rock'], LC.bare, 'rgba(0,0,0,0)'] } });
    add(under, 'landuse', 'fill', 'landuse', { minzoom: up(11), filter: inList(cls, ['residential', 'suburb', 'commercial', 'retail', 'industrial']), paint: { 'fill-color': '#dcc3ad', 'fill-opacity': z([11, 0.55, 13, 0.8]) } });
    add(under, 'park', 'line', 'park', { minzoom: up(9), paint: { 'line-color': '#7f9a78', 'line-width': 0.9, 'line-dasharray': [4, 2], 'line-opacity': 0.8 } });
    add(under, 'building', 'fill', 'building', { minzoom: 14, paint: { 'fill-color': '#e2d6c0', 'fill-opacity': z([14, 0, 15, 0.75]), 'fill-outline-color': '#cdbfa5' } });
    add(under, 'water', 'fill', 'water', { minzoom: from, filter: poly, paint: { 'fill-color': '#b1c9cc' } });
    var riverW = function (small) { return z([6, small ? 0.4 : 0.8, 12, small ? 0.9 : 2.2, 14, small ? 1.2 : 3]); };
    add(under, 'river', 'line', 'waterway', { minzoom: from, filter: inList(cls, ['river', 'canal']), paint: { 'line-color': '#97b6bb', 'line-width': riverW(false) } });
    add(under, 'stream', 'line', 'waterway', { minzoom: up(13), filter: ['!', inList(cls, ['river', 'canal'])], paint: { 'line-color': '#97b6bb', 'line-width': riverW(true) } });
    add(under, 'rail', 'line', 'transportation', { minzoom: up(8), filter: ['all', line, ['==', cls, 'rail'], ['!', inList(sub, ['subway', 'tram', 'funicular'])]], paint: { 'line-color': '#8c8a7a', 'line-width': 1, 'line-dasharray': [6, 4] } });
    var road = function (id, classes, color, stops, minzoom, casing) {
      var f = ['all', line, inList(cls, classes)], lay = { 'line-cap': 'round', 'line-join': 'round' };
      if (casing) add(under, id + '-casing', 'line', 'transportation', { minzoom: up(minzoom), filter: f, layout: lay, paint: { 'line-color': '#fbf7ec', 'line-opacity': 0.85, 'line-width': wide(stops, casing) } });
      add(under, id, 'line', 'transportation', { minzoom: up(minzoom), filter: f, layout: lay, paint: { 'line-color': color, 'line-width': wide(stops, 0) } });
      return under[under.length - 1];
    };
    road('road-minor', ['minor', 'service', 'raceway'], '#e0d2b8', RW.minor, 12);
    road('road-path', ['path', 'track'], '#a8987c', RW.path, 12).paint['line-dasharray'] = [3, 2];
    road('road-county', ['secondary', 'tertiary'], ROAD.cty, RW.cty, 9, 1.2);
    road('road-national', ['trunk', 'primary'], ROAD.nat, RW.nat, 6, 1.2);
    road('road-expressway', ['motorway'], ROAD.hw, RW.hw, 5, 1.2);
    // admin boundaries: OSM admin_level 4 province, 5-6 prefecture, 8 county (China) only; never country (<= 2), disputed or maritime lines
    [['county', [8], 0.6, [2, 2], 9], ['prefecture', [5, 6], 0.9, [3, 2], 6], ['province', [4], 1.2, [4, 2], 4]].forEach(function (b) {
      add(under, 'boundary-' + b[0], 'line', 'boundary', { minzoom: up(b[4]), filter: ['all', line, inList(['get', 'admin_level'], b[1]), ['>', ['get', 'admin_level'], 2], ['!', ['to-boolean', ['get', 'disputed']]], ['!', ['to-boolean', ['get', 'maritime']]]],
        layout: { 'line-join': 'round' }, paint: { 'line-color': BOUNDARY, 'line-width': b[2], 'line-dasharray': b[3], 'line-opacity': 0.9 } });
    });
    // labels
    var halo = function (color, w) { return { 'text-color': color, 'text-halo-color': '#f5f2e9', 'text-halo-width': w }; };
    var waterPaint = { 'text-color': '#4f7a78', 'text-halo-color': '#e4eae3', 'text-halo-width': 1.2 };
    add(over, 'label-river', 'symbol', 'waterway', { minzoom: up(9), filter: ['all', line, HANN], layout: { 'symbol-placement': 'line', 'text-field': NAME, 'text-font': REG, 'text-size': 11 }, paint: waterPaint });
    add(over, 'label-water', 'symbol', 'water_name', { minzoom: up(8), filter: HANN, layout: { 'text-field': NAME, 'text-font': REG, 'text-size': 12, 'text-letter-spacing': 0.1, 'text-max-width': 6 }, paint: waterPaint });
    var roadName = function (id, classes, minzoom, size) {
      add(over, id, 'symbol', 'transportation_name', { minzoom: up(minzoom), filter: ['all', line, HANN, inList(cls, classes)], layout: { 'symbol-placement': 'line', 'symbol-spacing': 280, 'text-field': NAME, 'text-font': REG, 'text-size': size, 'text-max-angle': 30, 'text-padding': 4 }, paint: halo('#7a6a52', 1.4) });
    };
    roadName('label-road-major', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'], 13, 10.5);
    roadName('label-road-minor', ['minor'], 14, 10);
    var poi = function (id, layer, filter, minzoom, image, color, sort) {
      add(over, id, 'symbol', layer, { minzoom: up(minzoom), filter: ['all', ['==', ['geometry-type'], 'Point'], HANN, filter], layout: {
        'icon-image': image, 'text-field': NAME, 'text-font': REG, 'text-size': 10.5, 'text-optional': true, 'text-padding': 3, 'icon-padding': 4, 'text-max-width': 7,
        'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 0.7, 'symbol-sort-key': sort }, paint: halo(color, 1.5) });
    };
    poi('poi-service', 'poi', inList(cls, POI_SERVICE), 14, 'tm-poi-svc', '#8b7a5e', 3);
    poi('poi-scenic', 'poi', inList(cls, POI_SCENIC), 13, 'tm-poi', '#58765f', ['match', cls, ['attraction', 'viewpoint'], 0, ['museum', 'theme_park', 'zoo', 'park'], 1, ['place_of_worship', 'religious', 'castle', 'monument'], 2, 4]);
    poi('poi-peak', 'mountain_peak', ['has', 'name'], 12, 'tm-poi', '#58765f', ['coalesce', ['get', 'rank'], 9]);
    // G/S route numbers in a paper box along the road; compound refs ("G233;S207") read "G233 S207"
    var ref = ['to-string', ['get', 'ref']], semi = ['index-of', ';', ref];
    add(over, 'label-road-ref', 'symbol', 'transportation_name', { minzoom: up(9), filter: ['all', line, ['has', 'ref'], inList(cls, ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']), inList(['slice', ref, 0, 1], ['G', 'S'])], layout: {
      'symbol-placement': 'line', 'symbol-spacing': 420, 'text-field': ['case', ['>=', semi, 0], ['concat', ['slice', ref, 0, semi], ' ', ['slice', ref, ['+', semi, 1]]], ref],
      'text-font': MED, 'text-size': 10, 'text-padding': 8, 'text-max-angle': 25, 'icon-image': 'tm-ref', 'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 4, 1, 4], 'icon-rotation-alignment': 'map' },
      paint: { 'text-color': ['case', ['==', cls, 'motorway'], '#7a4f2e', '#8a6a4a'] } });
    // place names: city, town, village, hamlet, suburb; no country/state/province labels
    var place = function (id, classes, size, color, minzoom, font) {
      add(over, id, 'symbol', 'place', { minzoom: up(minzoom), filter: ['all', ['==', ['geometry-type'], 'Point'], inList(cls, classes), HANN], layout: { 'text-field': NAME, 'text-font': font || REG, 'text-size': size, 'text-padding': 4, 'text-max-width': 8,
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 22 / size, 'text-justify': 'auto', 'symbol-sort-key': ['coalesce', ['get', 'rank'], 99] }, paint: halo(color, 1.6) });
    };
    place('label-hamlet', ['hamlet', 'suburb', 'quarter', 'neighbourhood', 'isolated_dwelling', 'island'], 10.5, '#6b7a6c', 13);
    place('label-village', ['village'], 11, '#5f6f61', 12);
    place('label-town', ['town'], 12.5, '#33493d', 7);
    place('label-city', ['city'], 15, '#203d30', 4, MED);
    add(over, 'label-transit', 'symbol', 'aerodrome_label', { minzoom: up(11), filter: HANN, layout: { 'text-field': NAME, 'text-font': REG, 'text-size': 10.5 }, paint: halo('#6b7a6c', 1.4) });
    add(over, 'label-station', 'symbol', 'poi', { minzoom: up(11), filter: ['all', ['==', cls, 'railway'], ['==', sub, 'station'], HANN], layout: { 'text-field': NAME, 'text-font': REG, 'text-size': 10.5 }, paint: halo('#6b7a6c', 1.4) });
    return { under: under, over: over };
  }

  // Rounded paper box behind road numbers (9-slice so it stretches to the text)
  function addRefBox(map) {
    var px = 2, w = 24, h = 16, c = document.createElement('canvas'); c.width = w * px; c.height = h * px;
    var x = c.getContext('2d'); x.scale(px, px);
    x.beginPath(); x.moveTo(5, 1); x.arcTo(w - 1, 1, w - 1, h - 1, 4); x.arcTo(w - 1, h - 1, 1, h - 1, 4); x.arcTo(1, h - 1, 1, 1, 4); x.arcTo(1, 1, w - 1, 1, 4); x.closePath();
    x.fillStyle = 'rgba(255,253,248,0.94)'; x.fill(); x.lineWidth = 1; x.strokeStyle = '#c9b290'; x.stroke();
    map.addImage('tm-ref', x.getImageData(0, 0, w * px, h * px), { pixelRatio: px, stretchX: [[8 * px, 16 * px]], stretchY: [[6 * px, 10 * px]], content: [6 * px, 4 * px, 18 * px, 12 * px] });
  }

  // Point markers are symbol layers (so place labels collide with them); their circles are drawn here.
  function circleImage(r, sw, color, alpha) {
    var px = 2, d = Math.ceil(2 * r + sw) + 2, c = document.createElement('canvas'); c.width = c.height = d * px;
    var x = c.getContext('2d'); x.scale(px, px); x.globalAlpha = alpha || 1;
    x.beginPath(); x.arc(d / 2, d / 2, r, 0, 2 * Math.PI); x.fillStyle = color; x.fill();
    x.lineWidth = sw; x.strokeStyle = PAPER; x.stroke();
    return x.getImageData(0, 0, d * px, d * px);
  }
  function addMarkerImages(map) {
    var o = { pixelRatio: 2 };
    map.addImage('tm-poi', circleImage(3.2, 1.5, '#6d8f76'), o);
    map.addImage('tm-poi-svc', circleImage(2.8, 1.5, '#b09a76'), o);
    Object.keys(KIND_COLOR).forEach(function (k) {
      var photo = k === 'photo';
      map.addImage('tm-' + k, circleImage(photo ? 11 : 13, 2, KIND_COLOR[k]), o);
      map.addImage('tm-' + k + '-a', circleImage(photo ? 14 : 16, 3, KIND_COLOR[k]), o);
    });
    ['main', 'photo'].forEach(function (src) {
      var color = src === 'photo' ? KIND_COLOR.photo : KIND_COLOR.stop;
      map.addImage('tm-c-' + src + '-s', circleImage(16, 2.5, color, 0.94), o);
      map.addImage('tm-c-' + src + '-l', circleImage(19, 2.5, color, 0.94), o);
    });
  }

  function ZoomControl(map, onFit) {
    this.el = document.createElement('div'); this.el.className = 'tm-zoom maplibregl-ctrl';
    [['+', '放大', 1], ['−', '缩小', -1]].forEach(function (d) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'tm-btn'; b.textContent = d[0]; b.setAttribute('aria-label', d[1]);
      b.addEventListener('click', function () { map.easeTo({ zoom: map.getZoom() + d[2], duration: 250 }); });
      this.el.append(b);
    }, this);
    if (onFit) { var f = document.createElement('button'); f.type = 'button'; f.className = 'tm-btn tm-fit'; f.textContent = '全景'; f.setAttribute('aria-label', '查看全景'); f.addEventListener('click', onFit); this.el.append(f); }
  }
  ZoomControl.prototype.onAdd = function () { return this.el; };
  ZoomControl.prototype.onRemove = function () { this.el.remove(); };

  function AttributionBar(landcover) {
    this.el = document.createElement('div'); this.el.className = 'tm-attrib maplibregl-ctrl';
    this.el.innerHTML = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> · <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> · <a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">Mapterhorn</a>'
      + (landcover ? ' · <a href="https://esa-worldcover.org" target="_blank" rel="noopener">ESA WorldCover</a>' : '')
      + '<span class="tm-detail-credit" hidden> · <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a></span>';
  }
  AttributionBar.prototype.detail = function (on) { this.el.querySelector('.tm-detail-credit').hidden = !on; };
  AttributionBar.prototype.onAdd = function () { return this.el; };
  AttributionBar.prototype.onRemove = function () { this.el.remove(); };

  function toFeatures(points, merge) {
    var split = { main: [], photo: [] };
    points.forEach(function (p) {
      split[p.kind === 'photo' && !merge ? 'photo' : 'main'].push({ type: 'Feature', geometry: { type: 'Point', coordinates: p.lngLat },
        properties: { id: p.id, kind: p.kind || 'stop', label: p.label == null ? '' : String(p.label), color: KIND_COLOR[p.kind] || KIND_COLOR.stop } });
    });
    return { main: { type: 'FeatureCollection', features: split.main }, photo: { type: 'FeatureCollection', features: split.photo } };
  }

  function create(opts) {
    var container = typeof opts.container === 'string' ? document.querySelector(opts.container) : opts.container;
    if (!container) return null;
    if (!window.maplibregl || !window.pmtiles || !webglOk()) {
      if (opts.onUnsupported) opts.onUnsupported();
      return null;
    }
    if (!protocolReady) {
      // A vector tile missing from the archive (outside a detailed tier) is reported as a 404, which MapLibre draws as an empty tile (see baseFullZoom).
      var proto = new pmtiles.Protocol({ errorOnMissingTile: true });
      maplibregl.addProtocol('pmtiles', function (req, ac) {
        return Promise.resolve(proto.tile(req, ac)).catch(function (e) { if (e && e.message === 'Tile not found.') e.status = 404; throw e; });
      });
      protocolReady = true;
    }

    var coarse = matchMedia('(max-width: 980px)');
    var points = (opts.points || []).slice();
    var byId = {};
    var activeRoutes = opts.activeRoutes || [];
    var activeId = null;
    var routeData = { type: 'FeatureCollection', features: [] };
    var routesSet = false;
    var style = buildStyle(opts);
    style.sources.routes = { type: 'geojson', data: routeData };
    var fc = toFeatures(points, opts.mergeClusters);
    style.sources.main = { type: 'geojson', data: fc.main, cluster: true, clusterRadius: 36, clusterMaxZoom: opts.clusterMaxZoom || 11 };
    style.sources.photo = { type: 'geojson', data: fc.photo, cluster: true, clusterRadius: 30, clusterMaxZoom: opts.clusterMaxZoom || 13 };

    var map = new maplibregl.Map({
      container: container, style: style, attributionControl: false, localIdeographFontFamily: CJK_FONT,
      cooperativeGestures: true, dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0, minZoom: 4, maxZoom: opts.maxZoom || 13, center: [120.8, 48.2], zoom: 6, maxBounds: opts.maxBounds,
      locale: { 'CooperativeGesturesHandler.WindowsHelpText': '按住 Ctrl 并滚动来缩放地图', 'CooperativeGesturesHandler.MacHelpText': '按住 ⌘ 并滚动来缩放地图', 'CooperativeGesturesHandler.MobileHelpText': '用双指移动地图' }
    });
    map.touchZoomRotate.disableRotation();
    var api;
    map.addControl(new ZoomControl(map, opts.fitButton === false ? null : function () { api.fitAll(); }), 'top-left');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 90 }), 'bottom-right');
    var attrib = new AttributionBar(!!opts.landcover);
    map.addControl(attrib, 'bottom-right');
    container.classList.add('tm-map');

    // Online detail: see the header comment. detailOn = the d-* layers are in the style; detailGone = it failed once and stays off (offline rendering).
    var detailFrom = opts.detailFromZoom || 11, offMax = opts.maxZoom || 13, detailOn = false, detailGone = !opts.detail, detailIds = [], detailErr = 0;
    var capped = style.layers.filter(function (l) { return (l.source === 'base' || l.source === 'base-detail') && l.id !== 'earth' && l.id !== 'landcover'; }).map(function (l) { return [l.id, l.minzoom || 0]; });
    var softRaster = ['landcover', 'landcover-lo'].filter(function (id) { return style.layers.some(function (l) { return l.id === id && l.type === 'raster'; }); });
    function setDetail(on) {
      capped.forEach(function (c) { map.setLayerZoomRange(c[0], c[1], on ? detailFrom : 24); });
      softRaster.forEach(function (id) { map.setPaintProperty(id, 'raster-opacity', on ? z([13, 1, 15, 0.6]) : 1); });
      map.setMaxZoom(on ? Math.max(offMax, opts.detailMaxZoom || 16) : offMax);
      attrib.detail(on);
      detailOn = on;
    }
    function startDetail(tilejson) {
      var d = detailLayers(detailFrom);
      map.addSource('detail', { type: 'vector', tiles: tilejson.tiles, maxzoom: tilejson.maxzoom || 14, attribution: '' });
      d.under.forEach(function (l) { map.addLayer(l, 'route-casing'); });
      d.over.forEach(function (l) { map.addLayer(l, 'main-cluster'); });
      detailIds = d.under.concat(d.over).map(function (l) { return l.id; });
      setDetail(true);
    }
    function stopDetail() { // back to the self-hosted rendering for good
      detailGone = true;
      if (!detailOn) return;
      try {
        detailIds.forEach(function (id) { if (map.getLayer(id)) map.removeLayer(id); });
        if (map.getSource('detail')) map.removeSource('detail');
      } catch (x) { /* the style is already gone */ }
      setDetail(false);
    }
    map.on('data', function (e) { if (e.sourceId === 'detail' && e.tile) detailErr = 0; });

    var failed = false;
    map.on('error', function (e) {
      var err = e && e.error;
      if (e && e.sourceId === 'detail') { // isolated failed tiles are tolerated; 4 in a row with no success drops the source
        if (detailOn && !(err && (err.name === 'AbortError' || err.status === 404)) && ++detailErr >= 4) setTimeout(stopDetail, 0);
        return;
      }
      if (failed || !e.sourceId || (err && err.name === 'AbortError')) return;
      if (e.sourceId === 'base') {
        failed = true;
        var n = document.createElement('div'); n.className = 'tm-error'; n.textContent = opts.errorText || '地图瓦片加载失败，请使用站点列表和高德链接。';
        container.append(n);
      }
    });

    function iconFor(active) {
      return ['case', active, ['concat', 'tm-', ['get', 'kind'], '-a'], ['concat', 'tm-', ['get', 'kind']]];
    }
    function pointLayers(src) {
      var single = ['!', ['has', 'point_count']];
      var none = ['==', ['get', 'id'], ['literal', '']];
      var icon = { 'icon-allow-overlap': true, 'icon-ignore-placement': false, 'text-font': MED, 'text-allow-overlap': true, 'text-ignore-placement': true };
      return [
        { id: src + '-cluster', type: 'symbol', source: src, filter: ['has', 'point_count'], layout: Object.assign({
          'icon-image': ['concat', 'tm-c-', src, '-', ['step', ['get', 'point_count'], 's', 5, 'l']], 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 13 }, icon), paint: { 'text-color': PAPER } },
        { id: src + '-halo', type: 'circle', source: src, filter: ['all', single, none], paint: { 'circle-radius': 22, 'circle-color': ['get', 'color'], 'circle-opacity': 0.2 } },
        { id: src + '-dot', type: 'symbol', source: src, filter: single, layout: Object.assign({
          'icon-image': iconFor(none), 'text-field': ['get', 'label'], 'text-size': src === 'photo' ? 11.5 : 13 }, icon), paint: { 'text-color': PAPER } },
        { id: src + '-hit', type: 'circle', source: src, filter: single, paint: { 'circle-radius': 22, 'circle-color': '#000', 'circle-opacity': 0.001 } }
      ];
    }
    var main = pointLayers('main'), photo = pointLayers('photo');
    photo.forEach(function (l) { l.minzoom = 8; });
    var pointLayerDefs = main.concat(photo);

    function setActivePaint() {
      if (!map.getLayer('main-dot')) return;
      ['main', 'photo'].forEach(function (src) {
        var active = ['==', ['get', 'id'], activeId == null ? '' : String(activeId)];
        map.setLayoutProperty(src + '-dot', 'icon-image', iconFor(active));
        map.setFilter(src + '-halo', ['all', ['!', ['has', 'point_count']], active]);
      });
    }
    function setRoutePaint() {
      if (!map.getLayer('route-line')) return;
      var on = ['in', ['get', 'id'], ['literal', activeRoutes]];
      map.setPaintProperty('route-line', 'line-opacity', ['case', on, 1, 0.3]);
      map.setPaintProperty('route-casing', 'line-opacity', ['case', on, 1, 0.3]);
      map.setPaintProperty('route-dir', 'text-opacity', ['case', on, 0.9, 0]);
    }
    function routeBounds(ids) {
      var b = new maplibregl.LngLatBounds(), any = false;
      routeData.features.forEach(function (f) {
        if (ids && ids.indexOf(f.properties.id) < 0) return;
        f.geometry.coordinates.forEach(function (c) { b.extend(c); any = true; });
      });
      return any ? b : null;
    }
    function defaultPadding() {
      if (opts.fitPadding) return opts.fitPadding;
      return coarse.matches ? { top: 72, bottom: 56, left: 64, right: 32 } : { top: 72, bottom: 64, left: 64, right: 48 };
    }
    function fitBounds(b, o) {
      o = o || {};
      map.fitBounds(b, { padding: o.padding || defaultPadding(), maxZoom: o.maxZoom || 11, duration: o.duration == null ? 700 : o.duration });
    }
    function indexPoints() { byId = {}; points.forEach(function (p) { byId[p.id] = p; }); }
    indexPoints();

    var ready = new Promise(function (resolve) {
      map.on('load', function () {
        addMarkerImages(map); addRefBox(map);
        pointLayerDefs.forEach(function (l) { map.addLayer(l); });
        // casing/line sources are in the style already; keep route layers below point layers
        setRoutePaint(); setActivePaint();
        resolve();
      });
    });
    // the probe runs while the style loads; the layers go in once both are done (the point layers must exist to insert below them)
    var detailReady = new Promise(function (resolve) {
      if (!opts.detail) return resolve(false);
      var ac = new AbortController(), timer = setTimeout(function () { ac.abort(); }, 4000);
      var probe = fetch(opts.detail, { signal: ac.signal }).then(function (r) { if (!r.ok) throw new Error('detail ' + r.status); return r.json(); })
        .then(function (j) { if (!j || !Array.isArray(j.tiles) || !j.tiles.length) throw new Error('detail tilejson'); return j; });
      Promise.all([probe, ready]).then(function (r) { if (!detailGone) startDetail(r[0]); resolve(detailOn); })
        .catch(function () { detailGone = true; resolve(false); }).then(function () { clearTimeout(timer); });
    });
    var routes = opts.routes;
    Promise.resolve(typeof routes === 'string' ? fetch(routes).then(function (r) { return r.json(); }) : routes).then(function (data) {
      if (data && !routesSet) routeData = data;
      return ready;
    }).then(function () {
      map.getSource('routes').setData(routeData);
      setRoutePaint();
      if (routesSet) return; // the page drives the view through setRoutes + fitTo
      var b = routeBounds(activeRoutes.length ? activeRoutes : null);
      if (b) fitBounds(b, { duration: 0 });
      else if (points.length) fitTo(points.map(function (p) { return p.lngLat; }), { duration: 0 });
    }).catch(function () { /* routes are optional: points and base map still work */ });

    function fitTo(lngLats, o) {
      var b = new maplibregl.LngLatBounds(); lngLats.forEach(function (c) { b.extend(c); });
      fitBounds(b, o);
    }

    map.on('click', function (e) {
      var cl = map.queryRenderedFeatures(e.point, { layers: ['main-cluster', 'photo-cluster'].filter(function (id) { return map.getLayer(id); }) })[0];
      if (cl) {
        var src = map.getSource(cl.source);
        src.getClusterExpansionZoom(cl.properties.cluster_id).then(function (zoom) {
          map.easeTo({ center: cl.geometry.coordinates, zoom: Math.min(zoom + 0.3, map.getMaxZoom()), duration: 500 });
        });
        return;
      }
      var f = map.queryRenderedFeatures(e.point, { layers: ['main-hit', 'photo-hit'].filter(function (id) { return map.getLayer(id); }) })[0];
      if (f && opts.onPointClick) opts.onPointClick(byId[f.properties.id], f);
    });
    ['main-cluster', 'photo-cluster', 'main-hit', 'photo-hit'].forEach(function (id) {
      map.on('mouseenter', id, function () { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, function () { map.getCanvas().style.cursor = ''; });
    });

    api = {
      map: map,
      ready: ready,
      detailReady: detailReady,   // Promise<boolean>: true once the online detail layers are active (false: offline rendering)
      detailActive: function () { return detailOn; },
      setPoints: function (next) {
        points = next.slice(); indexPoints();
        var d = toFeatures(points, opts.mergeClusters);
        ready.then(function () { map.getSource('main').setData(d.main); map.getSource('photo').setData(d.photo); });
      },
      setActiveRoute: function (ids) { activeRoutes = ids || []; setRoutePaint(); },
      setRoutes: function (data) {
        routeData = data; routesSet = true;
        ready.then(function () { map.getSource('routes').setData(routeData); setRoutePaint(); });
      },
      focusPoint: function (id, o) {
        o = o || {};
        var p = byId[id]; if (!p) return;
        activeId = id; setActivePaint();
        if (o.fly === false) return;
        var coords = [p.lngLat].concat((o.context || []).map(function (c) { return byId[c] && byId[c].lngLat; }).filter(Boolean));
        var b = new maplibregl.LngLatBounds(); coords.forEach(function (c) { b.extend(c); });
        map.stop();
        map.fitBounds(b, { padding: o.padding || defaultPadding(), maxZoom: o.maxZoom || (p.kind === 'photo' ? 12.5 : 10.5), duration: 800 });
      },
      clearFocus: function () { activeId = null; setActivePaint(); },
      fitTo: fitTo,
      fitAll: function (o) { activeId = null; setActivePaint(); var b = routeBounds(activeRoutes.length ? activeRoutes : null); if (b) fitBounds(b, o); else fitTo(points.map(function (p) { return p.lngLat; }), o); },
      destroy: function () { map.remove(); }
    };
    return api;
  }

  function wgs84ToGcj02(lon, lat) {
    if (![lon, lat].every(Number.isFinite) || Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new RangeError('Invalid geographic coordinate');
    if (!(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55)) return [lon, lat];
    var pi = Math.PI, x = lon - 105, y = lat - 35;
    var common = (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
    var dy = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)) + common;
    dy += (20 * Math.sin(y * pi) + 40 * Math.sin(y / 3 * pi)) * 2 / 3;
    dy += (160 * Math.sin(y / 12 * pi) + 320 * Math.sin(y * pi / 30)) * 2 / 3;
    var dx = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)) + common;
    dx += (20 * Math.sin(x * pi) + 40 * Math.sin(x / 3 * pi)) * 2 / 3;
    dx += (150 * Math.sin(x / 12 * pi) + 300 * Math.sin(x / 30 * pi)) * 2 / 3;
    var rad = lat / 180 * pi, magic = 1 - 0.00669342162296594323 * Math.pow(Math.sin(rad), 2), root = Math.sqrt(magic);
    return [lon + dx * 180 / (6378245 / root * Math.cos(rad) * pi), lat + dy * 180 / (6378245 * (1 - 0.00669342162296594323) / (magic * root) * pi)];
  }

  function navSegments(stops) {
    var out = [];
    for (var i = 0; i < stops.length - 1; i += 2) out.push({ part: i / 2 + 1, stops: stops.slice(i, i + 3) });
    return out;
  }

  function amapRoute(stops, src) {
    if (!Array.isArray(stops) || stops.length < 2 || stops.length > 3) throw new RangeError('Amap navigation requires two or three stops');
    var pos = function (s) { var xy = wgs84ToGcj02(s.lngLat[0], s.lngLat[1]); return xy[0].toFixed(6) + ',' + xy[1].toFixed(6) + ',' + s.name; };
    var params = new URLSearchParams({ from: pos(stops[0]), to: pos(stops[stops.length - 1]), mode: 'car', policy: '0', callnative: '1', src: src });
    if (stops.length === 3) params.set('via', pos(stops[1]));
    return 'https://uri.amap.com/navigation?' + params.toString();
  }

  function renderLegend(el) {
    var chip = function (bg, text) { return '<span class="tm-key"><i class="tm-chip" style="background:' + bg + '"></i>' + text + '</span>'; };
    var ln = function (border, text) { return '<span class="tm-key"><i class="tm-line" style="border-top:' + border + '"></i>' + text + '</span>'; };
    el.classList.add('tm-legend');
    el.innerHTML = chip(LC.forest, '森林') + chip('linear-gradient(90deg,' + LC.shrub + ' 50%,' + LC.grass + ' 50%)', '灌丛草地') + chip(LC.farm, '农田') + chip(LC.built, '城镇')
      + chip('linear-gradient(90deg,' + LC.water + ' 50%,' + LC.wetland + ' 50%)', '水体湿地') + chip(LC.bare, '裸地')
      + ln('3.4px solid ' + ROAD.hw, '高速') + ln('2.6px solid ' + ROAD.nat, '国道省道') + ln('1.9px solid ' + ROAD.cty, '县道') + ln('1.5px dashed ' + BOUNDARY, '县界')
      + '<span class="tm-key"><i class="tm-dot" style="background:#6d8f76"></i>景点</span><span class="tm-key"><i class="tm-dot" style="background:#b09a76"></i>停车、加油、住宿</span>';
  }

  window.TripMap = { create: create, renderLegend: renderLegend, navSegments: navSegments, amapRoute: amapRoute, wgs84ToGcj02: wgs84ToGcj02 };
})();
