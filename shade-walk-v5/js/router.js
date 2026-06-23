/**
 * router.js — Dijkstra's algorithm over the OSM walking graph, where each
 * segment's cost is its real-world length scaled up if it's sunlit.
 *
 * cost(edge) = length * (1 + sunPenalty * sunFraction)
 *
 * sunPenalty = 0   → identical to plain shortest-path (ignore shade)
 * sunPenalty high  → willing to walk much further to stay in shade
 *
 * This one cost function is what makes "small detour for more shade" work:
 * the path search will only take a longer way around when the shade it
 * buys is worth more than the extra distance costs, given sunPenalty.
 */

class MinHeap {
  constructor() {
    this.items = []; // {key, dist}
  }
  get size() {
    return this.items.length;
  }
  push(key, dist) {
    this.items.push({ key, dist });
    this._bubbleUp(this.items.length - 1);
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this._bubbleDown(0);
    }
    return top;
  }
  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].dist <= this.items[i].dist) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }
  _bubbleDown(i) {
    const n = this.items.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.items[l].dist < this.items[smallest].dist) smallest = l;
      if (r < n && this.items[r].dist < this.items[smallest].dist) smallest = r;
      if (smallest === i) break;
      [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
      i = smallest;
    }
  }
}

function edgeCost(edge, sunPenalty) {
  const shadeFraction = edge.shadeFraction ?? 0.5;
  const sunFraction = 1 - shadeFraction;
  return edge.length * (1 + sunPenalty * sunFraction);
}

/**
 * Returns { nodeIds, edgeIds, distance, shadedDistance } or null if there's
 * no path between startId and endId in the fetched area.
 */
function findRoute(adjacency, edges, startId, endId, sunPenalty) {
  const dist = new Map([[startId, 0]]);
  const prev = new Map(); // nodeId -> { from, edgeId }
  const visited = new Set();
  const heap = new MinHeap();
  heap.push(startId, 0);

  while (heap.size > 0) {
    const { key: current, dist: currentDist } = heap.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    if (current === endId) break;

    const neighbors = adjacency.get(current) || [];
    for (const { to, edgeId } of neighbors) {
      if (visited.has(to)) continue;
      const edge = edges.get(edgeId);
      const candidate = currentDist + edgeCost(edge, sunPenalty);
      if (candidate < (dist.get(to) ?? Infinity)) {
        dist.set(to, candidate);
        prev.set(to, { from: current, edgeId });
        heap.push(to, candidate);
      }
    }
  }

  if (!dist.has(endId)) return null;

  // Walk the prev-chain back to start.
  const nodeIds = [endId];
  const edgeIds = [];
  let cursor = endId;
  while (cursor !== startId) {
    const step = prev.get(cursor);
    if (!step) return null; // shouldn't happen if dist.has(endId), but be safe
    edgeIds.unshift(step.edgeId);
    nodeIds.unshift(step.from);
    cursor = step.from;
  }

  let distance = 0;
  let shadedDistance = 0;
  for (const edgeId of edgeIds) {
    const edge = edges.get(edgeId);
    distance += edge.length;
    shadedDistance += edge.length * (edge.shadeFraction ?? 0.5);
  }

  return { nodeIds, edgeIds, distance, shadedDistance };
}

/** True if two route results follow the exact same sequence of street segments. */
function routesAreEqual(a, b) {
  if (!a || !b) return false;
  if (a.edgeIds.length !== b.edgeIds.length) return false;
  for (let i = 0; i < a.edgeIds.length; i++) {
    if (a.edgeIds[i] !== b.edgeIds[i]) return false;
  }
  return true;
}
