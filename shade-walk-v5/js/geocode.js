/**
 * geocode.js — free address search via OpenStreetMap's Nominatim service.
 *
 * Nominatim's usage policy asks for light, non-bulk use and a way to
 * identify the app (we can't set a custom User-Agent from browser fetch,
 * but the Referer header browsers send automatically covers that for a
 * small personal project). Keep queries debounced — see app.js.
 */

const Geocode = {
  /** Returns up to `limit` candidate places for a free-text query. */
  async search(query, limit = 5) {
    if (!query || query.trim().length < 3) return [];
    const url =
      "https://nominatim.openstreetmap.org/search" +
      `?format=jsonv2&q=${encodeURIComponent(query)}&limit=${limit}`;

    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
    const results = await res.json();

    return results.map((r) => ({
      label: r.display_name,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
    }));
  },

  /** Turns a lat/lon back into a human-readable label, best-effort. */
  async reverse(lat, lon) {
    const url =
      "https://nominatim.openstreetmap.org/reverse" + `?format=jsonv2&lat=${lat}&lon=${lon}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const r = await res.json();
    if (!r || !r.display_name) return null;
    return { label: r.display_name, lat, lon };
  },
};
