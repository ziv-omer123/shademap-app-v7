/**
 * osm.js — pulls the walkable street network and building footprints for an
 * area straight from OpenStreetMap (via the public Overpass API) and turns
 * them into a graph we can route over, plus GeoJSON for the shadow layer.
 *
 * No API key needed. Be a polite neighbor to the free Overpass instance:
 * one query per route search, not on every keystroke.
 */

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Highway types people can reasonably walk on.
const EXCLUDED_HIGHWAY = /^(motorway|motorway_link|trunk|trunk_link|construction|proposed|raceway)$/;
const EXCLUDED_ACCESS = /^(private|no)$/;

function buildOverpassQuery([south, west, north, east]) {
  const bbox = `${south},${west},${north},${east}`;
  return `
[out:json][timeout:25];
(
  way["highway"]["highway"!~"${EXCLUDED_HIGHWAY.source}"]["foot"!~"^(no|private)$"]["access"!~"${EXCLUDED_ACCESS.source}"](${bbox});
  way["building"](${bbox});
);
out body;
>;
out skel qt;
`.trim();
}

/** height in meters from OSM tags, with sane fallbacks. */
function buildingHeightFromTags(tags) {
  if (tags.height) {
    const h = parseFloat(String(tags.height).replace(/[^\d.]/g, ""));
    if (!Number.isNaN(h) && h > 0) return h;
  }
  if (tags["building:levels"]) {
    const levels = parseFloat(tags["building:levels"]);
    if (!Number.isNaN(levels) && levels > 0) return levels * 3;
  }
  return 6; // ~2-storey default when OSM has no height data
}

/** Decide how many points along an edge to sample for shade. */
function samplePointsForEdge(aLat, aLon, bLat, bLon, length) {
  const fractions = length > 150 ? [0.25, 0.5, 0.75] : length > 60 ? [0.33, 0.66] : [0.5];
  return fractions.map((t) => ({
    lat: aLat + (bLat - aLat) * t,
    lon: aLon + (bLon - aLon) * t,
  }));
}

/**
 * Fetch + parse everything needed for one route search.
 * bbox = [south, west, north, east]
 */
async function fetchWalkableGraph(bbox) {
  const query = buildOverpassQuery(bbox);
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`Overpass request failed (${res.status})`);
  const json = await res.json();

  const nodeCoords = new Map(); // id -> {lat, lon}
  const highwayWays = [];
  const buildingWays = [];

  for (const el of json.elements) {
    if (el.type === "node") {
      nodeCoords.set(el.id, { lat: el.lat, lon: el.lon });
    } else if (el.type === "way" && el.tags) {
      if (el.tags.highway) highwayWays.push(el);
      else if (el.tags.building) buildingWays.push(el);
    }
  }

  // --- Build the routable graph ---
  const nodes = new Map(); // id -> {lat, lon}  (only nodes actually used by highways)
  const adjacency = new Map(); // id -> [{to, edgeId, length}]
  const edges = new Map(); // edgeId -> {id, a, b, length, samplePoints, shadeFraction}
  let edgeCounter = 0;

  const ensureNode = (id) => {
    if (!nodes.has(id) && nodeCoords.has(id)) nodes.set(id, nodeCoords.get(id));
    if (!adjacency.has(id)) adjacency.set(id, []);
  };

  for (const way of highwayWays) {
    const ids = way.nodes.filter((id) => nodeCoords.has(id));
    for (let i = 0; i < ids.length - 1; i++) {
      const aId = ids[i];
      const bId = ids[i + 1];
      const a = nodeCoords.get(aId);
      const b = nodeCoords.get(bId);
      const length = haversineMeters(a.lat, a.lon, b.lat, b.lon);
      if (length < 0.5) continue; // skip duplicate/zero-length segments

      ensureNode(aId);
      ensureNode(bId);

      const edgeId = edgeCounter++;
      edges.set(edgeId, {
        id: edgeId,
        a: aId,
        b: bId,
        length,
        samplePoints: samplePointsForEdge(a.lat, a.lon, b.lat, b.lon, length),
        shadeFraction: null, // filled in by shade.js
        highway: way.tags.highway,
      });

      adjacency.get(aId).push({ to: bId, edgeId, length });
      adjacency.get(bId).push({ to: aId, edgeId, length });
    }
  }

  // --- Building footprints, as GeoJSON for the shadow simulator ---
  const buildingFeatures = [];
  for (const way of buildingWays) {
    const ids = way.nodes;
    if (ids.length < 4 || ids[0] !== ids[ids.length - 1]) continue; // need a closed ring
    const coords = [];
    let ok = true;
    for (const id of ids) {
      const c = nodeCoords.get(id);
      if (!c) {
        ok = false;
        break;
      }
      coords.push([c.lon, c.lat]);
    }
    if (!ok) continue;
    buildingFeatures.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [coords] },
      properties: { height: buildingHeightFromTags(way.tags), render_height: buildingHeightFromTags(way.tags) },
    });
  }

  return { nodes, adjacency, edges, buildingFeatures };
}

/** Nearest graph node to a given lat/lon — brute force is plenty fast at this scale. */
function nearestNode(nodes, lat, lon) {
  let bestId = null;
  let bestDist = Infinity;
  for (const [id, coord] of nodes) {
    const d = haversineMeters(lat, lon, coord.lat, coord.lon);
    if (d < bestDist) {
      bestDist = d;
      bestId = id;
    }
  }
  return bestId === null ? null : { id: bestId, distance: bestDist };
}
