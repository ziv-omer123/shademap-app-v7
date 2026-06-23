/**
 * app.js — wires the UI together across three screens:
 *
 *   planning  → fill in From/To/time, hit "Find shaded routes"
 *   comparing → map-only screen, three route options drawn + labeled,
 *               tap one to choose it
 *   selected  → only the chosen route remains, stats panel appears
 *
 * The actual route-finding (fetch streets/buildings, render + sample
 * shadows, run the weighted search) happens once per "Find shaded routes"
 * click — the three tiers below are just three different sunPenalty values
 * run through the same graph, so switching between them later (via
 * "Choose a different route") doesn't refetch anything.
 */

// ---------- Route preference tiers ----------
// Higher penalty = more willing to add distance for shade. Tune here.
// Colors are kept in sync with the legend in index.html's footer.

const TIERS = [
  { key: "fastest", label: "Fastest", sub: "least shade", penalty: 0, color: "#ffffff" },
  { key: "balanced", label: "Balanced", sub: "", penalty: 2.2, color: "#e8973a" },
  { key: "shade", label: "Most shade", sub: "slowest", penalty: 6.0, color: "#5b8c7b" },
];

// ---------- Map + shadow layer setup ----------

const map = L.map("map", { zoomControl: true, doubleClickZoom: false }).setView([48.8566, 2.3522], 13);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

let buildingFeaturesCache = [];

const shadeMap = L.shadeMap({
  date: new Date(),
  color: "#1c2227",
  opacity: 0.55,
  apiKey: CONFIG.SHADEMAP_API_KEY,
  terrainSource: {
    tileSize: 256,
    maxZoom: 15,
    getSourceUrl: ({ x, y, z }) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    getElevation: ({ r, g, b, a }) => r * 256 + g + b / 256 - 32768,
  },
  getFeatures: () => buildingFeaturesCache,
}).addTo(map);

// ---------- State ----------

let fromPoint = null; // {lat, lon}
let toPoint = null;
let fromMarker = null;
let toMarker = null;
let nextPointRole = "from";

let lastGraph = null; // cached so "choose a different route" doesn't refetch
let lastGroups = null; // cached {route, tiers}[] from the last search
let compareLayers = []; // layers shown on the comparison screen
let selectedLayers = []; // layers shown on the selected-route screen

// ---------- DOM refs ----------

const el = (id) => document.getElementById(id);
const fromInput = el("from-input");
const toInput = el("to-input");
const datetimeInput = el("datetime-input");
const findBtn = el("find-route-btn");
const statusLine = el("status-line");
const errorBox = el("error-box");
const planningPanel = el("planning-panel");
const compareOverlay = el("compare-overlay");
const selectedOverlay = el("selected-overlay");
const sunDot = el("sun-dot");
const sunStatusText = el("sun-status-text");

// ---------- Small helpers ----------

function setStatus(msg) {
  statusLine.textContent = msg || "";
}
function showError(msg) {
  errorBox.hidden = false;
  errorBox.textContent = msg;
}
function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}
function markerFor(role) {
  return role === "from" ? fromMarker : toMarker;
}
function nodeLatLng(nodes, id) {
  const n = nodes.get(id);
  return [n.lat, n.lon];
}

/** Removes everything in `arr` from the map, whether it's a raw Leaflet
 *  layer (selectedLayers) or a {polyline, marker} pair (compareLayers). */
function clearLayers(arr) {
  for (const item of arr) {
    if (item.remove) item.remove();
    if (item.polyline) item.polyline.remove();
    if (item.marker) item.marker.remove();
  }
  arr.length = 0;
}

// ---------- From / To points ----------

function setPoint(role, lat, lon, label) {
  const point = { lat, lon };
  const color = role === "from" ? "#5b8c7b" : "#e8973a";

  if (markerFor(role)) {
    markerFor(role).setLatLng([lat, lon]);
  } else {
    const marker = L.circleMarker([lat, lon], {
      radius: 9,
      color: "#1c2227",
      weight: 2,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(map);
    if (role === "from") fromMarker = marker;
    else toMarker = marker;
  }

  if (role === "from") {
    fromPoint = point;
    if (label) fromInput.value = label;
  } else {
    toPoint = point;
    if (label) toInput.value = label;
  }

  nextPointRole = role === "from" ? "to" : "from";
  updateSunGauge();
}

// ---------- Sun gauge ----------

function currentDate() {
  return datetimeInput.value ? new Date(datetimeInput.value) : new Date();
}

function updateSunGauge() {
  const date = currentDate();
  const refPoint = fromPoint || map.getCenter();
  const lat = refPoint.lat;
  const lon = refPoint.lon !== undefined ? refPoint.lon : refPoint.lng;

  const { elevation } = Solar.getPosition(date, lat, lon);
  const progress = Solar.getDayProgress(date, lat, lon);

  const cx = lerp(20, 260, progress);
  const t = clamp((elevation + 20) / 95, 0, 1);
  const cy = lerp(78, 10, t);

  sunDot.setAttribute("cx", cx.toFixed(1));
  sunDot.setAttribute("cy", cy.toFixed(1));
  sunDot.style.fill = elevation < 0 ? "var(--paper-200)" : "var(--sun-500)";

  if (elevation < -6) sunStatusText.textContent = "It's dark out — the whole area is naturally in shade.";
  else if (elevation < 0) sunStatusText.textContent = "Sun is below the horizon — dusk or dawn light only.";
  else if (elevation < 20) sunStatusText.textContent = "Sun is low — long shadows, plenty of shade to find.";
  else if (elevation < 50) sunStatusText.textContent = "Sun is at a moderate angle — a mix of sun and shade.";
  else sunStatusText.textContent = "Sun is high overhead — shade will be scarce.";
}

datetimeInput.addEventListener("change", updateSunGauge);

function setDatetimeToNow() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  datetimeInput.value = now.toISOString().slice(0, 16);
  updateSunGauge();
}

setDatetimeToNow();
el("now-btn").addEventListener("click", setDatetimeToNow);

// ---------- Address fields ----------

function wireAddressField(inputEl, listEl, role) {
  const search = debounce(async () => {
    const query = inputEl.value.trim();
    if (query.length < 3) {
      listEl.hidden = true;
      return;
    }
    try {
      const results = await Geocode.search(query);
      if (results.length === 0) {
        listEl.hidden = true;
        return;
      }
      listEl.innerHTML = "";
      results.forEach((r) => {
        const li = document.createElement("li");
        li.textContent = r.label;
        li.addEventListener("click", () => {
          setPoint(role, r.lat, r.lon, r.label);
          listEl.hidden = true;
        });
        listEl.appendChild(li);
      });
      listEl.hidden = false;
    } catch {
      listEl.hidden = true;
    }
  }, 350);

  inputEl.addEventListener("input", search);
  inputEl.addEventListener("blur", () => setTimeout(() => (listEl.hidden = true), 150));
}

wireAddressField(fromInput, el("from-suggestions"), "from");
wireAddressField(toInput, el("to-suggestions"), "to");

el("swap-btn").addEventListener("click", () => {
  const tmp = fromPoint;
  fromPoint = toPoint;
  toPoint = tmp;
  const tmpVal = fromInput.value;
  fromInput.value = toInput.value;
  toInput.value = tmpVal;
  if (fromPoint) setPoint("from", fromPoint.lat, fromPoint.lon);
  if (toPoint) setPoint("to", toPoint.lat, toPoint.lon);
});

el("use-location-btn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showError("Your browser doesn't support geolocation.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      let label = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
      try {
        const r = await Geocode.reverse(latitude, longitude);
        if (r) label = r.label;
      } catch {
        /* fall back to coordinates */
      }
      setPoint("from", latitude, longitude, label);
      map.setView([latitude, longitude], 15);
    },
    () => showError("Couldn't get your location — check your browser's location permission."),
  );
});

map.on("dblclick", async (e) => {
  const { lat, lng } = e.latlng;
  const label = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const role = nextPointRole;
  setPoint(role, lat, lng, label);
  try {
    const r = await Geocode.reverse(lat, lng);
    if (r) setPoint(role, lat, lng, r.label);
  } catch {
    /* keep the coordinate label */
  }
});

// ---------- Screen transitions ----------

function showPlanningScreen() {
  document.body.classList.remove("is-comparing");
  planningPanel.hidden = false;
  compareOverlay.hidden = true;
  selectedOverlay.hidden = true;
  clearLayers(compareLayers);
  clearLayers(selectedLayers);
}

function showCompareScreen() {
  document.body.classList.add("is-comparing");
  planningPanel.hidden = true;
  selectedOverlay.hidden = true;
  compareOverlay.hidden = false;
  clearLayers(selectedLayers);
}

function showSelectedScreen() {
  document.body.classList.remove("is-comparing");
  compareOverlay.hidden = true;
  selectedOverlay.hidden = false;
  clearLayers(compareLayers);
}

el("back-to-planning-btn").addEventListener("click", showPlanningScreen);
el("change-route-btn").addEventListener("click", () => {
  if (!lastGraph || !lastGroups) return;
  showCompareScreen();
  drawCompareGroups(lastGraph, lastGroups);
});

// ---------- Building + rendering the three route options ----------

/** Groups tiers whose searches landed on the exact same street sequence. */
function groupTierRoutes(tierRoutes) {
  const groups = [];
  for (const tr of tierRoutes) {
    const existing = groups.find((g) => routesAreEqual(g.route, tr.route));
    if (existing) existing.tiers.push(tr.tier);
    else groups.push({ route: tr.route, tiers: [tr.tier] });
  }
  return groups;
}

function groupLabelHtml(group, color) {
  const names = group.tiers.map((t) => t.label).join(" = ");
  const sub = group.tiers.length === 1 && group.tiers[0].sub ? ` · ${group.tiers[0].sub}` : "";
  const distance = formatDistance(group.route.distance);
  const time = formatWalkTime(group.route.distance);
  const shadePct = Math.round((group.route.shadedDistance / group.route.distance) * 100);
  return (
    `<div class="route-option-label" style="border-color:${color}">` +
    `<strong style="color:${color}">${names}${sub}</strong>` +
    `<span class="label-sub">${time} · ${distance} · ${shadePct}% shade</span>` +
    `</div>`
  );
}

/** True for very light colors (e.g. white) that would wash out on light basemap tiles. */
function isLightColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.75;
}

function drawCompareGroups(graph, groups) {
  clearLayers(compareLayers);

  // Settle the view FIRST (no animation) so every position we measure below
  // is final — otherwise label de-overlap math would be chasing a moving target.
  const allPts = groups.flatMap((g) => g.route.nodeIds.map((id) => nodeLatLng(graph.nodes, id)));
  if (allPts.length) map.fitBounds(L.latLngBounds(allPts), { padding: [70, 70], animate: false });

  const markerEntries = [];

  for (const group of groups) {
    const color = group.tiers[0].color;
    const latlngs = group.route.nodeIds.map((id) => nodeLatLng(graph.nodes, id));
    const onSelect = () => selectGroup(graph, group);

    // A faint dark casing keeps near-white routes visible over light basemap areas.
    if (isLightColor(color)) {
      const casing = L.polyline(latlngs, { color: "#1c2227", weight: 8, opacity: 0.5 }).addTo(map);
      casing.on("click", onSelect);
      compareLayers.push({ polyline: casing });
    }

    const polyline = L.polyline(latlngs, { color, weight: 5, opacity: 0.95 }).addTo(map);
    polyline.on("click", onSelect);
    polyline.on("mouseover", () => polyline.setStyle({ weight: 7 }));
    polyline.on("mouseout", () => polyline.setStyle({ weight: 5 }));
    compareLayers.push({ polyline });

    // Invisible, much wider line purely to make tapping a route on a phone
    // screen realistic — a 5px line is a tiny, fiddly target for a finger.
    const hitArea = L.polyline(latlngs, { color: "#000000", weight: 26, opacity: 0 }).addTo(map);
    hitArea.on("click", onSelect);
    compareLayers.push({ polyline: hitArea });

    const midIdx = Math.max(0, Math.floor(latlngs.length * 0.45));
    const marker = L.marker(latlngs[midIdx], {
      icon: L.divIcon({
        className: "route-option-marker",
        html: groupLabelHtml(group, color),
        iconSize: null,
      }),
    }).addTo(map);
    marker.on("click", onSelect);
    compareLayers.push({ marker });

    markerEntries.push({ marker });
  }

  if (fromMarker) fromMarker.bringToFront();
  if (toMarker) toMarker.bringToFront();

  layoutCompareLabels(markerEntries);
  // Re-run once webfonts are ready in case their final width differs from the fallback font.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => layoutCompareLabels(markerEntries));
  }
}

/**
 * Nudges overlapping route-option labels apart so every one stays fully
 * readable, without moving the routes themselves. Works purely in screen
 * pixels: measure each label's real rendered box, push overlapping pairs
 * apart along whichever axis needs the smaller move, then apply the result
 * as a per-marker iconAnchor offset (so it survives map pans/zooms, since
 * Leaflet recomputes marker position from iconAnchor on every redraw).
 */
function layoutCompareLabels(markerEntries) {
  if (markerEntries.length < 2) return;

  const mapRect = map.getContainer().getBoundingClientRect();

  // Recover each label's un-shifted ("natural") position by subtracting any
  // offset a previous pass already applied — so re-running this after
  // webfonts load reasons from the same baseline instead of compounding.
  const boxes = markerEntries.map(({ marker }) => {
    const r = marker.getElement().getBoundingClientRect();
    const [prevDx, prevDy] = marker._declutterOffset || [0, 0];
    return {
      x: r.left - mapRect.left - prevDx,
      y: r.top - mapRect.top - prevDy,
      w: r.width,
      h: r.height,
    };
  });
  const natural = boxes.map((b) => ({ ...b }));

  const PAD = 8;
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (overlapX <= -PAD || overlapY <= -PAD) continue; // not overlapping, leave them

        moved = true;
        if (overlapX < overlapY) {
          const push = (overlapX + PAD) / 2;
          if (a.x + a.w / 2 <= b.x + b.w / 2) {
            a.x -= push;
            b.x += push;
          } else {
            a.x += push;
            b.x -= push;
          }
        } else {
          const push = (overlapY + PAD) / 2;
          if (a.y + a.h / 2 <= b.y + b.h / 2) {
            a.y -= push;
            b.y += push;
          } else {
            a.y += push;
            b.y -= push;
          }
        }
      }
    }
    if (!moved) break;
  }

  // Keep every label inside the visible map, and below the top overlay bar.
  for (const b of boxes) {
    b.x = clamp(b.x, 4, mapRect.width - b.w - 4);
    b.y = clamp(b.y, 56, mapRect.height - b.h - 8);
  }

  markerEntries.forEach(({ marker }, i) => {
    const dx = Math.round(boxes[i].x - natural[i].x);
    const dy = Math.round(boxes[i].y - natural[i].y);
    marker._declutterOffset = [dx, dy];
    const icon = marker.options.icon;
    marker.setIcon(
      L.divIcon({
        className: icon.options.className,
        html: icon.options.html,
        iconSize: null,
        iconAnchor: [-dx, -dy],
      }),
    );
  });
}

function fastestRouteFromGroups(groups) {
  const tr = groups.flatMap((g) => g.tiers.map((t) => ({ tier: t, route: g.route }))).find((tr) => tr.tier.key === "fastest");
  return tr ? tr.route : null;
}

function selectGroup(graph, group) {
  showSelectedScreen();

  const fastestRoute = fastestRouteFromGroups(lastGroups);

  // Faint dashed reference line for the fastest option, unless that's the
  // one chosen (then it'd just sit exactly underneath, so skip it).
  if (fastestRoute && !routesAreEqual(group.route, fastestRoute)) {
    const fastestLatLngs = fastestRoute.nodeIds.map((id) => nodeLatLng(graph.nodes, id));
    selectedLayers.push(
      L.polyline(fastestLatLngs, {
        color: "#ffffff",
        weight: 3,
        opacity: 0.85,
        dashArray: "2 8",
      }).addTo(map),
    );
  }

  for (let i = 0; i < group.route.edgeIds.length; i++) {
    const edge = graph.edges.get(group.route.edgeIds[i]);
    const a = nodeLatLng(graph.nodes, group.route.nodeIds[i]);
    const b = nodeLatLng(graph.nodes, group.route.nodeIds[i + 1]);
    const isShaded = (edge.shadeFraction ?? 0.5) >= 0.5;
    selectedLayers.push(
      L.polyline([a, b], {
        color: isShaded ? "#5b8c7b" : "#e8973a",
        weight: 5,
        opacity: 0.95,
      }).addTo(map),
    );
  }

  if (fromMarker) fromMarker.bringToFront();
  if (toMarker) toMarker.bringToFront();

  const latlngs = group.route.nodeIds.map((id) => nodeLatLng(graph.nodes, id));
  map.fitBounds(L.latLngBounds(latlngs), { padding: [60, 60] });

  fillResults(group.route, fastestRoute);
}

function fillResults(route, fastestRoute) {
  el("readout-distance").textContent = formatDistance(route.distance);
  el("readout-time").textContent = formatWalkTime(route.distance);

  const shadePct = Math.round((route.shadedDistance / route.distance) * 100);
  el("readout-shade").textContent = `${shadePct}%`;

  if (fastestRoute && fastestRoute.distance > 0) {
    const deltaPct = Math.round(((route.distance - fastestRoute.distance) / fastestRoute.distance) * 100);
    el("readout-detour").textContent = deltaPct <= 1 ? "Same as fastest" : `+${deltaPct}% distance`;
  } else {
    el("readout-detour").textContent = "—";
  }
}

// ---------- Find routes ----------

findBtn.addEventListener("click", async () => {
  clearError();
  if (!fromPoint || !toPoint) {
    showError("Set both a starting point and a destination first.");
    return;
  }

  findBtn.disabled = true;
  clearLayers(compareLayers);
  clearLayers(selectedLayers);

  try {
    setStatus("Looking up walkable streets nearby…");
    const bbox = bufferedBbox(fromPoint.lat, fromPoint.lon, toPoint.lat, toPoint.lon, 250);
    const graph = await fetchWalkableGraph(bbox);

    if (graph.nodes.size === 0) {
      showError("No walkable streets found between those points.");
      return;
    }
    buildingFeaturesCache = graph.buildingFeatures;

    setStatus("Snapping to the nearest paths…");
    const startSnap = nearestNode(graph.nodes, fromPoint.lat, fromPoint.lon);
    const endSnap = nearestNode(graph.nodes, toPoint.lat, toPoint.lon);
    if (!startSnap || !endSnap) {
      showError("Couldn't find a mapped path near one of your points.");
      return;
    }

    setStatus("Reading the sky for this date and time…");
    shadeMap.setDate(currentDate());
    await sampleShadeForGraph(map, shadeMap, bbox, graph.edges, (done, total) =>
      setStatus(`Reading the sky… (${done}/${total} street segments)`),
    );

    setStatus("Comparing fastest, balanced, and shadiest paths…");
    const tierRoutes = TIERS.map((tier) => ({
      tier,
      route: findRoute(graph.adjacency, graph.edges, startSnap.id, endSnap.id, tier.penalty),
    })).filter((tr) => tr.route);

    if (tierRoutes.length === 0) {
      showError("No walking route found between these points in the mapped area. Try points closer together.");
      return;
    }
    if (tierRoutes[0].route.distance < 5) {
      showError("Start and destination are too close together — pick points a bit further apart.");
      return;
    }

    lastGraph = graph;
    lastGroups = groupTierRoutes(tierRoutes);

    showCompareScreen();
    drawCompareGroups(lastGraph, lastGroups);
    setStatus("");
  } catch (err) {
    console.error(err);
    showError("Something went wrong fetching map or shade data. Check your connection and try again.");
    setStatus("");
  } finally {
    findBtn.disabled = false;
  }
});
