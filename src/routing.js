export class RouteError extends Error {
  constructor(message) {
    super(message);
    this.name = "RouteError";
  }
}

/**
 * 景区路网：节点为景点/出入口/避雨点/充电点，路段可双向通行，
 * 携带步行时长、无障碍通行能力与实时容量。
 */
export class RouteNetwork {
  #nodes = new Map();
  #segments = new Map();
  #adjacent = new Map();

  constructor({ nodes, segments }) {
    for (const node of nodes) {
      this.#nodes.set(node.id, node);
      this.#adjacent.set(node.id, []);
    }
    for (const segment of segments) {
      if (!this.#nodes.has(segment.from) || !this.#nodes.has(segment.to)) {
        throw new RouteError(`路段 ${segment.id} 引用了未知节点`);
      }
      this.#segments.set(segment.id, segment);
      this.#adjacent.get(segment.from).push({ segment, next: segment.to });
      this.#adjacent.get(segment.to).push({ segment, next: segment.from });
    }
  }

  node(id) {
    const node = this.#nodes.get(id);
    if (!node) throw new RouteError(`未知节点：${id}`);
    return node;
  }

  segment(id) {
    const segment = this.#segments.get(id);
    if (!segment) throw new RouteError(`未知路段：${id}`);
    return segment;
  }

  adjacent(nodeId) {
    return this.#adjacent.get(nodeId) ?? [];
  }

  segmentIds() {
    return [...this.#segments.keys()];
  }

  /** 疏散目的地：出口与园区大门。 */
  exits() {
    return [...this.#nodes.values()].filter((n) => n.kind === "exit" || n.kind === "gate").map((n) => n.id);
  }

  chargingStations() {
    return [...this.#nodes.values()].filter((n) => n.kind === "charging").map((n) => n.id);
  }
}

/** 实时路况：客流负载、施工封闭、暴雨管制，供规划与回放快照使用。 */
export class LiveConditions {
  #network;
  #load = new Map();
  #closures = new Map();
  #weatherHolds = new Map();

  constructor(network) {
    this.#network = network;
  }

  setLoad(segmentId, load) {
    this.#network.segment(segmentId);
    if (!Number.isFinite(load) || load < 0) throw new RouteError(`负载不合法：${load}`);
    this.#load.set(segmentId, load);
  }

  loadOf(segmentId) {
    return this.#load.get(segmentId) ?? 0;
  }

  congestionOf(segmentId) {
    const { capacity } = this.#network.segment(segmentId);
    return capacity > 0 ? this.loadOf(segmentId) / capacity : 0;
  }

  close(segmentId, reason) {
    this.#network.segment(segmentId);
    this.#closures.set(segmentId, reason);
  }

  open(segmentId) {
    this.#closures.delete(segmentId);
  }

  holdForWeather(segmentId, reason) {
    this.#network.segment(segmentId);
    this.#weatherHolds.set(segmentId, reason);
  }

  clearWeather(segmentId) {
    this.#weatherHolds.delete(segmentId);
  }

  isBlocked(segmentId) {
    return this.#closures.has(segmentId) || this.#weatherHolds.has(segmentId);
  }

  blockedReason(segmentId) {
    return this.#closures.get(segmentId) ?? this.#weatherHolds.get(segmentId) ?? null;
  }

  snapshot() {
    const load = {};
    const congestion = {};
    for (const id of this.#network.segmentIds()) {
      load[id] = this.loadOf(id);
      congestion[id] = Math.round(this.congestionOf(id) * 1000) / 1000;
    }
    return {
      load,
      congestion,
      closures: Object.fromEntries(this.#closures),
      weather_holds: Object.fromEntries(this.#weatherHolds),
    };
  }
}

/**
 * 路线规划：Dijkstra，成本 = 步行时长 × (1 + 拥堵系数×2) + 改线惩罚。
 * 施工/暴雨路段硬跳过；无障碍队伍只走无障碍路段；满载路段硬跳过（疏散除外）；
 * avoidPenalties 用于避免把同一队伍反复导向刚避开的拥堵点。
 */
export class RoutePlanner {
  #network;
  #conditions;

  constructor(network, conditions) {
    this.#network = network;
    this.#conditions = conditions;
  }

  plan({ from, to, accessibleOnly = false, avoidPenalties = new Map(), ignoreCapacity = false }) {
    this.#network.node(from);
    this.#network.node(to);
    if (from === to) {
      return { legs: [], nodes: [from], eta_minutes: 0 };
    }
    const dist = new Map([[from, 0]]);
    const prev = new Map();
    const visited = new Set();
    while (true) {
      let current = null;
      let best = Infinity;
      for (const [node, cost] of dist) {
        if (!visited.has(node) && cost < best) {
          best = cost;
          current = node;
        }
      }
      if (current === null) break;
      if (current === to) break;
      visited.add(current);
      for (const { segment, next } of this.#network.adjacent(current)) {
        const cost = this.#segmentCost(segment, { accessibleOnly, avoidPenalties, ignoreCapacity });
        if (cost === null) continue;
        const total = best + cost;
        if (total < (dist.get(next) ?? Infinity)) {
          dist.set(next, total);
          prev.set(next, { node: current, segmentId: segment.id });
        }
      }
    }
    if (!prev.has(to)) {
      throw new RouteError(`从 ${from} 到 ${to} 无可行路线`);
    }
    const legs = [];
    const nodes = [to];
    let cursor = to;
    while (cursor !== from) {
      const step = prev.get(cursor);
      legs.unshift(step.segmentId);
      nodes.unshift(step.node);
      cursor = step.node;
    }
    return { legs, nodes, eta_minutes: Math.round(dist.get(to) * 10) / 10 };
  }

  #segmentCost(segment, { accessibleOnly, avoidPenalties, ignoreCapacity }) {
    if (this.#conditions.isBlocked(segment.id)) return null;
    if (accessibleOnly && !segment.accessible) return null;
    if (!ignoreCapacity && this.#conditions.loadOf(segment.id) >= segment.capacity) return null;
    const congestion = this.#conditions.congestionOf(segment.id);
    const penalty = avoidPenalties.get(segment.id) ?? 0;
    return segment.minutes * (1 + 2 * congestion) + penalty;
  }

  /** 依次途经各目标点的完整游程。 */
  planJourney({ from, goals, ...options }) {
    let node = from;
    const legs = [];
    const nodes = [from];
    let eta = 0;
    for (const goal of goals) {
      const sub = this.plan({ from: node, to: goal, ...options });
      legs.push(...sub.legs);
      nodes.push(...sub.nodes.slice(1));
      eta += sub.eta_minutes;
      node = goal;
    }
    return { legs, nodes, eta_minutes: Math.round(eta * 10) / 10 };
  }
}
