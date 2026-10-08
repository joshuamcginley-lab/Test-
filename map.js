"use strict";
/* Spots map on the Trips tab: every water and pinned spot on a map, sized by trips and coloured by fish per trip.
   Waters without a location can be placed by tapping the map. Leaflet loads only when the map is first opened.
   Uses globals from app.js. */

const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
// Approximate public locations for the sample season's waters (demo only; never saved to anyone's log).
const SAMPLE_WATERS = {
  "Keswick River": [45.995, -66.835], "Nashwaak River": [46.11, -66.62], "Saint John River": [45.99, -67.24],
  "Oromocto Lake": [45.66, -66.98], "Belleisle Bay": [45.60, -65.95], "Washademoak Lake": [45.87, -65.86],
  "Mactaquac Headpond": [45.975, -66.87], "French Lake": [45.90, -66.25], "Tay River": [46.15, -66.66],
  "Jemseg River": [45.83, -66.10], "Oromocto River": [45.85, -66.48], "Nashwaaksis Stream": [46.02, -66.68],
  "Peniac Stream": [46.03, -66.53], "Cains River": [46.55, -65.93],
};

let leafletP = null, map = null, layer = null, tiles = null, mapView = "list";
function loadLeaflet() {
  return leafletP ??= new Promise((res, rej) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = LEAFLET + "leaflet.css"; document.head.append(css);
    const js = document.createElement("script"); js.src = LEAFLET + "leaflet.js"; js.onload = () => res(window.L); js.onerror = rej; document.head.append(js);
  });
}
const darkMode = () => matchMedia("(prefers-color-scheme: dark)").matches;

// Group trips by water; each water sits at the average of its pinned trips (or the sample's approximate spot).
function mapGroups() {
  const by = new Map();
  for (const s of view()) {
    const k = s.water; if (!k) continue;
    if (!by.has(k)) by.set(k, { water: k, trips: [], pins: [] });
    const g = by.get(k); g.trips.push(s); if (s.lat != null) g.pins.push(s);
  }
  return [...by.values()].map(g => {
    let lat = null, lon = null, approx = false;
    if (g.pins.length) { lat = g.pins.reduce((a, s) => a + s.lat, 0) / g.pins.length; lon = g.pins.reduce((a, s) => a + s.lon, 0) / g.pins.length; }
    else if (demo && SAMPLE_WATERS[g.water]) { [lat, lon] = SAMPLE_WATERS[g.water]; approx = true; }
    const fish = g.trips.reduce((a, s) => a + fishOf(s), 0), skunk = g.trips.filter(s => !fishOf(s)).length;
    const lures = {}; g.trips.forEach(s => (s.catches || []).forEach(c => { if (c.lure) lures[c.lure] = (lures[c.lure] || 0) + c.count; }));
    const lure = Object.entries(lures).sort((a, b) => b[1] - a[1])[0]?.[0];
    return { ...g, lat, lon, approx, fish, skunk, rate: fish / g.trips.length, lure };
  });
}

async function renderMap() {
  const wrap = $("mapWrap"); if (mapView !== "map") return;
  const groups = mapGroups(), placed = groups.filter(g => g.lat != null), missing = groups.filter(g => g.lat == null);
  $("mapPlace").hidden = demo || !missing.length;
  $("mapPlaceSel").innerHTML = `<option value="">Choose a water…</option>` + missing.map(g => `<option>${esc(g.water)}</option>`).join("");
  $("mapNote").textContent = demo ? "Sample season: water locations are approximate." : missing.length ? `${missing.length} water${missing.length === 1 ? " has" : "s have"} no location yet.` : "";
  let L;
  try { L = await loadLeaflet(); } catch (e) { wrap.innerHTML = `<p class="status">The map needs a connection to load.</p>`; return; }
  if (!map) {
    map = L.map("spotsMap", { zoomControl: true, attributionControl: true }).setView([46.0, -66.6], 8);
    map.on("click", e => placeWater(e.latlng));
  }
  const style = darkMode() ? "dark_all" : "light_all";
  if (!tiles || tiles._style !== style) {
    tiles?.remove();
    tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, { maxZoom: 19, subdomains: "abcd", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>' }).addTo(map);
    tiles._style = style;
  }
  layer?.remove(); layer = L.layerGroup().addTo(map);
  const maxTrips = Math.max(1, ...placed.map(g => g.trips.length)), maxRate = Math.max(0.01, ...placed.map(g => g.rate));
  for (const g of placed) {
    const k = g.rate / maxRate, color = k > .66 ? "#C4FF2E" : k > .33 ? "#FFB21A" : "#FF6A13";
    const rad = 8 + 14 * Math.sqrt(g.trips.length / maxTrips);
    L.circleMarker([g.lat, g.lon], { radius: rad + 6, stroke: false, fillColor: color, fillOpacity: .18 }).addTo(layer);
    L.circleMarker([g.lat, g.lon], { radius: rad, color: "#070A14", weight: 2, fillColor: color, fillOpacity: .9 })
      .bindPopup(`<div class="map-pop"><b>${esc(g.water)}</b>${g.approx ? ` <span class="approx">approx.</span>` : ""}
        <div class="mp-stats"><span><b>${g.trips.length}</b> trip${g.trips.length === 1 ? "" : "s"}</span><span><b>${g.fish}</b> fish</span><span><b>${g.rate.toFixed(1)}</b>/trip</span><span><b>${Math.round(g.skunk / g.trips.length * 100)}%</b> skunk</span></div>
        ${g.lure ? `<div>Best lure: ${esc(g.lure)}</div>` : ""}
        <a href="${mapsUrl(g.lat, g.lon, g.water)}" target="_blank" rel="noopener">Open in ${mapsName()} ↗</a></div>`)
      .addTo(layer);
    // individual pinned spots
    for (const s of g.pins) if (Math.abs(s.lat - g.lat) > 0.002 || Math.abs(s.lon - g.lon) > 0.002)
      L.circleMarker([s.lat, s.lon], { radius: 4, color, weight: 2, fillColor: "#070A14", fillOpacity: 1 }).bindTooltip(`${esc(s.spot || g.water)} · ${fmtDate(s.date)} · ${fishOf(s)} fish`).addTo(layer);
  }
  setTimeout(() => {
    map.invalidateSize();
    if (placed.length) map.fitBounds(L.latLngBounds(placed.map(g => [g.lat, g.lon])).pad(0.25), { maxZoom: 12 });
  }, 50);
}

function placeWater(latlng) {
  const name = $("mapPlaceSel").value; if (!name || demo) return;
  const lat = r(latlng.lat, 5), lon = r(latlng.lng, 5);
  let n = 0; for (const s of state.sessions) if (s.water === name && s.lat == null) { s.lat = lat; s.lon = lon; n++; }
  save(); toast(`${name} placed (${n} trip${n === 1 ? "" : "s"})`); render();
}

function setView(v) {
  mapView = v;
  for (const b of $("viewSeg").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.v === v);
  $("mapWrap").hidden = v !== "map"; $("entries").hidden = v === "map";
  $("panel-log").querySelector(".filters").hidden = v === "map";
  renderMap();
}
$("viewSeg").onclick = e => { const b = e.target.closest("button"); if (b) setView(b.dataset.v); };
$("mapPlaceSel").onchange = () => { $("mapHint").hidden = !$("mapPlaceSel").value; };

// Re-draw the map whenever the app re-renders while it's open.
const _renderForMap = render;
render = function () { _renderForMap(); if (mapView === "map" && !$("panel-log").hidden) renderMap(); };
