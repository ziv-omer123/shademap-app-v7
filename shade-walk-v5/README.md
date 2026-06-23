# Shade Walk

Walking directions that favor shaded streets over the shortest path, using
real building-shadow simulation from [ShadeMap](https://shademap.app) and
street data from OpenStreetMap. No backend, no build step — just static
files.

## Running it

1. Open this folder in a terminal.
2. Start any static file server, for example:
   ```
   python3 -m http.server 8000
   ```
   (or `npx serve .`, or VS Code's "Live Server" extension)
3. Open `http://localhost:8000` in your browser.

Your ShadeMap API key only works on `http://localhost` right now. Once
you're ready to put this on a real domain, email **api@shademap.app** with
the domain — there's a licensing fee for that, per their note to you.

## Using it

- Type an address into **From** / **To**, or **double-click the map**
  (first double-click sets From, second sets To — a single click does
  nothing, on purpose, so you don't set a point by accident).
- Pick a date and time — shade depends entirely on where the sun is.
- Click **Find shaded routes**. The planning panel hides and the map
  takes over, showing three route options at once:
  - **Fastest** (white) — shortest path, least shade
  - **Balanced** (orange) — a moderate detour for noticeably more shade
  - **Most shade** (green) — willing to walk further to stay shaded
  
  Each route has a label on the map showing its walking time, distance,
  and % shaded — labels automatically nudge apart if they'd otherwise
  overlap, so all three stay readable. If two options land on the exact
  same street path (it happens), they're merged into one labeled option
  instead of drawn twice. A small legend at the very bottom of the page
  always shows what each color means.
- **Tap a route (the line or its label) to choose it.** The other
  options disappear, and the chosen route redraws segment-by-segment in
  green (shaded) and amber (sunlit), with distance, walking time, %
  shaded, and how it compares to the fastest option shown at the bottom.
- "Choose a different route" brings the three options back without
  re-fetching anything. "Plan a new route" goes back to the From/To
  screen.

## Files

| File | What it does |
|---|---|
| `index.html` | Page structure (planning panel + map-only comparison/selection screens) |
| `css/style.css` | All styling |
| `js/config.js` | Your ShadeMap API key (git-ignored — copy from `config.example.js`) |
| `js/utils.js` | Distance math, formatting, debounce |
| `js/solar.js` | Sun position calculation, for the little sky gauge |
| `js/geocode.js` | Address search/reverse-lookup via Nominatim (OpenStreetMap) |
| `js/osm.js` | Pulls streets + buildings from Overpass, builds the routing graph |
| `js/shade.js` | Renders the shadow layer and samples it along every street segment |
| `js/router.js` | Shade-weighted Dijkstra search + route-equality check (for de-duping options) |
| `js/app.js` | Wires everything together, including the planning → compare → selected screen flow |

## Known limitations (read before assuming a bug)

- **Building heights**: ShadeMap casts shadows from building footprints
  pulled from OpenStreetMap. Most buildings don't have a tagged height —
  this app falls back to `building:levels × 3m`, or 6m if even that's
  missing. Shade accuracy will vary by how well-tagged your area is.
- **Best for routes under ~2 km.** Shade is sampled by fitting the whole
  route into one map view and reading pixels — for longer routes the view
  zooms out and individual buildings render at lower detail. Works, just
  less precise at the edges. (A future version could tile the sampling
  across several zoomed-in views instead — flag it if you want that next.)
- **First run may still need debugging.** The shade-sampling step
  (`js/shade.js`) depends on exact timing behavior of a third-party
  rendering library (`leaflet-shadow-simulator`) that I could not test in
  a live browser while building this. It's been hardened to wait for the
  shadow layer to go quiet (not just the first render event) and logs its
  results to the console either way — see "If the three route options
  look identical" below.
- **Route labels can overlap on extreme cases** — they actively push apart
  in screen-pixel space to avoid it (see `layoutCompareLabels` in
  `app.js`), but with three labels packed into a small map view there's a
  hard limit to how much room there is. If it ever looks cramped, the
  fix is a bigger map view (zoom out) or a smaller `PAD`/font size.
- **Overpass and Nominatim are free public services** — fine for personal
  use, but avoid hammering them (e.g. don't wire route-finding to fire on
  every keystroke).

## Tuning

- The three tiers — penalty, label, and color — are defined in `app.js`
  as `TIERS` near the top of the file. Edit the `penalty` numbers to
  change how aggressive "Balanced" or "Most shade" are; edit `color` to
  change the route's color (keep the footer legend in `index.html` and
  the `chip-dot-*` rules in `style.css` in sync if you do).
- Sample density per street segment is in `osm.js` →
  `samplePointsForEdge`.
- Default map center (Paris) is in `app.js`, in the `L.map(...)` call.

## If the three route options look identical

Open the browser console after a search — `shade.js` logs the sampled
shade range (e.g. "shadeFraction range 0.10–0.95") and warns if it's
suspiciously flat. A flat range means every street segment looked equally
shaded/sunlit, so there was nothing for "Balanced" or "Most shade" to
trade distance for — the options will legitimately converge on the same
route. Common causes: it's nighttime at that location/time, the area has
very few tagged OSM buildings, or (less likely but possible) the shadow
layer hadn't finished rendering before sampling started.
