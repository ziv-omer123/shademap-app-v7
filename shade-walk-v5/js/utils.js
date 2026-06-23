/**
 * utils.js — small, dependency-free helpers shared by the rest of the app.
 */

/** Great-circle distance between two lat/lon points, in meters. */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Returns [south, west, north, east] padded outward by bufferMeters. */
function bufferedBbox(lat1, lon1, lat2, lon2, bufferMeters) {
  const south = Math.min(lat1, lat2);
  const north = Math.max(lat1, lat2);
  const west = Math.min(lon1, lon2);
  const east = Math.max(lon1, lon2);

  const midLat = (south + north) / 2;
  const dLat = bufferMeters / 111320;
  const dLon = bufferMeters / (111320 * Math.cos((midLat * Math.PI) / 180));

  return [south - dLat, west - dLon, north + dLat, east + dLon];
}

/** Debounce: only fire `fn` after `wait` ms of silence. */
function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** "1.2 km" or "450 m" */
function formatDistance(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

/** Walking time estimate at ~4.8 km/h, formatted as "12 min" or "1 h 5 min" */
function formatWalkTime(meters) {
  const minutes = Math.round((meters / 1000 / 4.8) * 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Simple sleep helper for pacing async UI updates. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
