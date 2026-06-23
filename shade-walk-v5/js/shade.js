/**
 * shade.js — turns the live ShadeMap layer into per-segment shade data.
 *
 * leaflet-shadow-simulator only answers "is this on-screen pixel in sun or
 * shade right now" (shadeMap.isPositionInSun(x, y), in CONTAINER pixels —
 * see their README). There's no "give me shade at any lat/lon" data API.
 * So: we fit the map to the route's area, wait for the shadow layer to
 * finish rendering that view, then convert each sample point's lat/lon to
 * an on-screen pixel and ask the layer directly.
 *
 * This is the part of the app most worth watching closely on a real run —
 * it depends on exact behavior of a third-party rendering library that
 * couldn't be tested live while building this.
 */

function waitForShadeIdle(shadeMap, { quietMs = 400, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let quietTimer = null;
    const hardTimer = setTimeout(finish, timeoutMs);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      resolve();
    }

    // The shadow layer can fire several 'idle' events in a row while tiles
    // progressively load after a view change. Resolve once it's been quiet
    // for a bit, rather than on the very first (possibly premature) idle.
    shadeMap.on("idle", () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    });
  });
}

function latLngBoundsFromBbox([south, west, north, east]) {
  return L.latLngBounds([south, west], [north, east]);
}

/**
 * Fits the map to `bbox`, waits for the shadow layer to render, then
 * samples every edge's points and fills in edge.shadeFraction (0 = fully
 * sunlit, 1 = fully shaded). Calls onProgress(done, total) periodically.
 */
async function sampleShadeForGraph(map, shadeMap, bbox, edges, onProgress) {
  map.fitBounds(latLngBoundsFromBbox(bbox), { padding: [40, 40], maxZoom: 18 });
  await waitForShadeIdle(shadeMap);
  // Give the basemap/shadow tiles one more beat to settle after the fit.
  await sleep(700);

  const size = map.getSize();
  const total = edges.size;
  let done = 0;
  let queryFailures = 0;
  let outOfView = 0;

  for (const edge of edges.values()) {
    let sunlitCount = 0;
    let sampledCount = 0;

    for (const pt of edge.samplePoints) {
      const { x, y } = map.latLngToContainerPoint([pt.lat, pt.lon]);
      if (x < 0 || y < 0 || x > size.x || y > size.y) {
        outOfView++;
        continue; // outside the rendered view
      }
      try {
        const inSun = await shadeMap.isPositionInSun(x, y);
        sampledCount++;
        if (inSun) sunlitCount++;
      } catch {
        queryFailures++;
        // If a single point query fails, just skip it rather than fail the whole route.
      }
    }

    edge.shadeFraction = sampledCount === 0 ? 0.5 : 1 - sunlitCount / sampledCount;
    done++;
    if (onProgress && (done % 20 === 0 || done === total)) onProgress(done, total);
  }

  // Diagnostics: if every edge ends up with basically the same shadeFraction,
  // the "shade preference" has nothing to work with and every route option
  // will look identical — this log line is how to tell why.
  const fractions = [...edges.values()].map((e) => e.shadeFraction);
  const min = Math.min(...fractions);
  const max = Math.max(...fractions);
  console.log(
    `[shade-walk] sampled ${total} segments — shadeFraction range ${min.toFixed(2)}–${max.toFixed(2)}` +
      (queryFailures ? `, ${queryFailures} point queries failed` : "") +
      (outOfView ? `, ${outOfView} points fell outside the rendered view` : ""),
  );
  if (max - min < 0.05) {
    console.warn(
      "[shade-walk] shade barely varies across this area for this date/time — route options will look very similar. " +
        "Likely causes: it's nighttime at this location, the area has few/no tagged buildings, or the shadow layer " +
        "didn't finish rendering before sampling (try increasing the settle delay in shade.js).",
    );
  }
}
