import { SEVERITY } from "./incidents.js";
import { RouteError } from "./routing.js";

export class DispatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "DispatchError";
  }
}

/** 改线原因 → 面向游客与值班人员的说明。 */
export const REVISION_REASONS = Object.freeze({
  initial: "生成初始游程",
  construction_closure: "路段施工封闭",
  weather_warning: "暴雨预警",
  congestion: "路段突发拥堵",
  low_battery: "设备电量不足",
  manual_override: "人工干预调整",
  emergency_evacuation: "紧急疏散",
  emergency_cleared: "疏散解除，恢复游程",
});

/** 改线惩罚（折算分钟）：刚避开的路段在冷却期内不被再次导向。 */
const AVOID_PENALTY_MINUTES = 60;

/**
 * 调度中枢：把同行组、无障碍需求、分时入园、设备能力、讲解内容版本、
 * 实时路段容量与现场告警编排成可调整的游程。
 * 每次改线都记录决策输入（客流、预警、施工、人工干预），供值班人员回放。
 */
export class DispatchCenter {
  #store;
  #ids;
  #decisionIds;
  #now;
  #audit;
  #fleet;
  #telemetry;
  #network;
  #conditions;
  #planner;
  #incidents;
  #rerouteCooldownMs;
  #congestionThreshold;

  #parties = new Map();
  #decisions = new Map();
  #manualLog = [];
  #avoid = new Map();
  #emergencyHold = new Set();
  #congestionIncidents = new Map();

  constructor({
    store,
    ids,
    decisionIds,
    now,
    audit,
    fleet,
    telemetry,
    network,
    conditions,
    planner,
    incidents,
    rerouteCooldownMs = 20 * 60_000,
    congestionThreshold = 0.8,
  }) {
    this.#store = store;
    this.#ids = ids;
    this.#decisionIds = decisionIds;
    this.#now = now;
    this.#audit = audit;
    this.#fleet = fleet;
    this.#telemetry = telemetry;
    this.#network = network;
    this.#conditions = conditions;
    this.#planner = planner;
    this.#incidents = incidents;
    this.#rerouteCooldownMs = rerouteCooldownMs;
    this.#congestionThreshold = congestionThreshold;
    telemetry.onSignal((signal) => this.#handleTelemetrySignal(signal));
  }

  // ---------- 预约与设备指派 ----------

  reserveVisit({
    party_id,
    size,
    accessibility_needs = [],
    entry_slot,
    entry_node,
    exit_node,
    visit_goals = [],
    content_version = null,
  }) {
    if (this.#parties.has(party_id)) {
      throw new DispatchError(`同行组已预约：${party_id}`);
    }
    if (!entry_slot?.start || !entry_slot?.end || !(entry_slot.start < entry_slot.end)) {
      throw new DispatchError("分时入园时段不合法");
    }
    this.#network.node(entry_node);
    const exitNode = exit_node ?? this.#network.exits()[0];
    this.#network.node(exitNode);
    for (const goal of visit_goals) {
      this.#network.node(goal);
    }
    this.#store.append({
      event_id: this.#ids(),
      event_type: "VISIT_RESERVED",
      aggregate_type: "visitor_party",
      aggregate_id: party_id,
      occurred_at: this.#now(),
      version: this.#store.latestVersion("visitor_party", party_id) + 1,
      summary: `预约伴游：${size} 人，${entry_slot.start} 入园`,
      payload: { size, accessibility_needs, entry_slot, entry_node, exit_node: exitNode, visit_goals, content_version },
    });
    const party = {
      party_id,
      size,
      accessibility_needs: [...accessibility_needs],
      entry_slot,
      entry_node,
      exit_node: exitNode,
      journey: [...visit_goals, exitNode],
      visited: [],
      current_node: entry_node,
      content_version,
      status: "active",
      current_plan: null,
    };
    this.#parties.set(party_id, party);
    this.#reviseRoute(party, { reason: "initial", detail: "按分时入园时段与无障碍需求生成初始游程" });
    return this.visitorView(party_id);
  }

  assignDevice(deviceId, partyId) {
    const party = this.#party(partyId);
    return this.#fleet.assign(deviceId, partyId, {
      contentVersion: party.content_version,
      reason: "initial_assignment",
    });
  }

  // ---------- 遥测接入 ----------

  ingestTelemetry(deviceId, message) {
    const result = this.#telemetry.ingest(deviceId, message);
    if (result.status === "applied" && this.#fleet.has(deviceId)) {
      const partyId = this.#fleet.partyOf(deviceId);
      if (partyId) {
        const location = this.#telemetry.snapshot(deviceId).location;
        if (location) {
          this.#updatePartyPosition(partyId, location.node);
        }
      }
    }
    return result;
  }

  #updatePartyPosition(partyId, node) {
    const party = this.#party(partyId);
    party.current_node = node;
    if (party.journey.includes(node) && !party.visited.includes(node)) {
      party.visited.push(node);
    }
    if (node === party.exit_node) {
      party.status = "completed";
    }
  }

  #handleTelemetrySignal(signal) {
    if (signal.type === "low_battery") {
      this.#handleLowBattery(signal.device_id, signal.battery_pct);
    }
    if (signal.type === "device_offline") {
      this.#audit.record({ kind: "device_offline", device_id: signal.device_id, at: signal.at });
    }
  }

  /** 低电量：优先无缝交接给可用设备/人工讲解队；无接替资源则改线经过充电点。 */
  #handleLowBattery(deviceId, batteryPct) {
    const partyId = this.#fleet.has(deviceId) ? this.#fleet.partyOf(deviceId) : null;
    if (!partyId) return;
    if (this.#emergencyHold.has(partyId)) return; // 疏散优先
    const party = this.#party(partyId);
    const current = this.#fleet.get(deviceId);
    const replacement = this.#fleet.selectReplacement({
      needs: party.accessibility_needs,
      contentVersion: party.content_version,
      exclude: deviceId,
      preferKind: current.kind,
    });
    if (replacement) {
      this.#handover(deviceId, replacement.device_id, party, "low_battery_handover", `电量 ${batteryPct}%`);
      return;
    }
    const charging = this.#nearest(party.current_node, this.#network.chargingStations(), {
      accessibleOnly: party.accessibility_needs.length > 0,
    });
    if (charging === null) return;
    const remaining = this.#remainingGoals(party).filter((goal) => goal !== charging);
    this.#reviseRoute(party, {
      reason: "low_battery",
      detail: `设备电量 ${batteryPct}%，改线经过充电点`,
      goals: [charging, ...remaining],
    });
  }

  // ---------- 现场扰动 ----------

  reportConstruction(segmentId, summary = "路段临时施工") {
    this.#conditions.close(segmentId, "construction");
    const incidentId = this.#incidents.raise({
      kind: "construction",
      severity: SEVERITY.WARNING,
      summary,
      segment_ids: [segmentId],
    });
    const revisions = this.#rerouteAffected([segmentId], {
      reason: "construction_closure",
      detail: summary,
    });
    return { incident_id: incidentId, revisions };
  }

  reportWeatherAlert(segmentIds, summary = "暴雨预警，路段临时管制") {
    for (const segmentId of segmentIds) {
      this.#conditions.holdForWeather(segmentId, "weather");
    }
    const incidentId = this.#incidents.raise({
      kind: "weather",
      severity: SEVERITY.CRITICAL,
      summary,
      segment_ids: segmentIds,
    });
    const revisions = this.#rerouteAffected(segmentIds, {
      reason: "weather_warning",
      detail: summary,
    });
    return { incident_id: incidentId, revisions };
  }

  updateCrowdLoad(segmentId, load) {
    this.#conditions.setLoad(segmentId, load);
    const congestion = this.#conditions.congestionOf(segmentId);
    const known = this.#congestionIncidents.get(segmentId);
    if (congestion >= this.#congestionThreshold && !known) {
      const incidentId = this.#incidents.raise({
        kind: "congestion",
        severity: SEVERITY.WARNING,
        summary: `路段 ${segmentId} 突发拥堵（${Math.round(congestion * 100)}%）`,
        segment_ids: [segmentId],
      });
      this.#congestionIncidents.set(segmentId, incidentId);
      return this.#rerouteAffected([segmentId], {
        reason: "congestion",
        detail: `路段 ${segmentId} 客流达到容量 ${Math.round(congestion * 100)}%`,
      });
    }
    if (congestion < this.#congestionThreshold / 2 && known) {
      this.#incidents.clear(known, "客流回落");
      this.#congestionIncidents.delete(segmentId);
    }
    return [];
  }

  /** 值班人员人工干预：全部留痕，进入后续调度决策的回放输入。 */
  manualIntervention({ by, action, segment_id = null, party_id = null, note = "" }) {
    const entry = { by, action, segment_id, party_id, note, at: this.#now() };
    this.#manualLog.push(entry);
    this.#audit.record({ kind: "manual_intervention", ...entry });
    switch (action) {
      case "close_segment":
        this.#conditions.close(segment_id, `manual:${by}`);
        this.#rerouteAffected([segment_id], { reason: "manual_override", detail: note || `值班员 ${by} 封闭路段` });
        break;
      case "open_segment":
        this.#conditions.open(segment_id);
        break;
      case "force_reroute":
        this.#reviseRoute(this.#party(party_id), { reason: "manual_override", detail: note || `值班员 ${by} 手动改线` });
        break;
      case "note":
        break;
      default:
        throw new DispatchError(`未知人工干预动作：${action}`);
    }
    return entry;
  }

  // ---------- 紧急疏散：压过一切普通推荐 ----------

  raiseEmergency({ segment_ids, summary }) {
    const incidentId = this.#incidents.raise({
      kind: "emergency",
      severity: SEVERITY.EMERGENCY,
      summary,
      segment_ids,
    });
    for (const party of this.#parties.values()) {
      if (party.status !== "active") continue;
      const threatened =
        this.#remainingLegs(party).some((leg) => segment_ids.includes(leg)) ||
        segment_ids.some((id) => {
          const segment = this.#network.segment(id);
          return segment.from === party.current_node || segment.to === party.current_node;
        });
      if (!threatened) continue;
      this.#emergencyHold.add(party.party_id);
      const exit = this.#nearest(party.current_node, this.#network.exits(), { ignoreCapacity: true });
      if (exit === null) continue;
      this.#reviseRoute(party, {
        reason: "emergency_evacuation",
        detail: summary,
        priority: "emergency",
        goals: [exit],
        ignoreCapacity: true,
      });
    }
    return incidentId;
  }

  clearEmergency(incidentId, note = "疏散解除") {
    this.#incidents.clear(incidentId, note);
    if (this.#incidents.activeEmergencies().length > 0) return;
    const held = [...this.#emergencyHold];
    this.#emergencyHold.clear();
    for (const partyId of held) {
      const party = this.#party(partyId);
      if (party.status !== "active") continue;
      this.#reviseRoute(party, { reason: "emergency_cleared", detail: note });
    }
  }

  // ---------- 设备故障：无缝转交人工服务 ----------

  reportDeviceFailure(deviceId, detail = "设备故障") {
    const device = this.#fleet.get(deviceId);
    const partyId = device.assigned_party;
    this.#fleet.markFailed(deviceId);
    const incidentId = this.#incidents.raise({
      kind: "device_failure",
      severity: SEVERITY.CRITICAL,
      summary: `${device.label} ${detail}`,
      party_ids: partyId ? [partyId] : [],
      details: { device_id: deviceId },
    });
    if (!partyId) {
      return { incident_id: incidentId, handover: null };
    }
    const party = this.#party(partyId);
    const replacement = this.#fleet.selectReplacement({
      needs: party.accessibility_needs,
      contentVersion: party.content_version,
      exclude: deviceId,
      preferKind: device.kind,
    });
    if (!replacement) {
      this.#fleet.release(deviceId, { reason: "device_failure" });
      this.#incidents.escalate(incidentId, SEVERITY.EMERGENCY, "无可用接替设备或人工讲解队");
      return { incident_id: incidentId, handover: null };
    }
    const handover = this.#handover(deviceId, replacement.device_id, party, "device_failure_handover", detail);
    return { incident_id: incidentId, handover };
  }

  #handover(fromDeviceId, toDeviceId, party, reason, detail) {
    if (this.#fleet.partyOf(fromDeviceId) === party.party_id) {
      this.#fleet.release(fromDeviceId, { reason });
    }
    const event = this.#fleet.assign(toDeviceId, party.party_id, {
      contentVersion: party.content_version,
      reason,
      supersedes: fromDeviceId,
    });
    this.#audit.record({
      kind: "device_handover",
      party_id: party.party_id,
      from_device: fromDeviceId,
      to_device: toDeviceId,
      reason,
      detail,
      at: this.#now(),
    });
    return event;
  }

  // ---------- 改线核心 ----------

  #party(partyId) {
    const party = this.#parties.get(partyId);
    if (!party) throw new DispatchError(`未知同行组：${partyId}`);
    return party;
  }

  #remainingGoals(party) {
    return party.journey.filter((goal) => !party.visited.includes(goal) && goal !== party.current_node);
  }

  /** 当前计划里尚未走过的路段（按当前位置截断）。 */
  #remainingLegs(party) {
    const plan = party.current_plan;
    if (!plan) return [];
    const index = plan.nodes.lastIndexOf(party.current_node);
    return index < 0 ? plan.legs : plan.legs.slice(index);
  }

  #rerouteAffected(segmentIds, { reason, detail }) {
    const revisions = [];
    for (const party of this.#parties.values()) {
      if (party.status !== "active") continue;
      if (this.#emergencyHold.has(party.party_id)) continue; // 疏散中的队伍不被普通推荐打扰
      const hit = this.#remainingLegs(party).filter((leg) => segmentIds.includes(leg));
      if (hit.length === 0) continue;
      this.#rememberAvoid(party.party_id, hit);
      const revision = this.#reviseRoute(party, { reason, detail });
      if (revision) revisions.push(revision);
    }
    return revisions;
  }

  #rememberAvoid(partyId, segmentIds) {
    if (!this.#avoid.has(partyId)) {
      this.#avoid.set(partyId, new Map());
    }
    const until = new Date(this.#now()).getTime() + this.#rerouteCooldownMs;
    for (const segmentId of segmentIds) {
      this.#avoid.get(partyId).set(segmentId, until);
    }
  }

  #avoidPenalties(partyId) {
    const memory = this.#avoid.get(partyId);
    const penalties = new Map();
    if (!memory) return penalties;
    const nowMs = new Date(this.#now()).getTime();
    for (const [segmentId, until] of memory) {
      if (until > nowMs) {
        penalties.set(segmentId, AVOID_PENALTY_MINUTES);
      } else {
        memory.delete(segmentId);
      }
    }
    return penalties;
  }

  #nearest(fromNode, candidates, { accessibleOnly = false, ignoreCapacity = false } = {}) {
    let best = null;
    let bestEta = Infinity;
    for (const candidate of candidates) {
      try {
        const plan = this.#planner.plan({ from: fromNode, to: candidate, accessibleOnly, ignoreCapacity });
        if (plan.eta_minutes < bestEta) {
          best = candidate;
          bestEta = plan.eta_minutes;
        }
      } catch (err) {
        if (!(err instanceof RouteError)) throw err;
      }
    }
    return best;
  }

  #reviseRoute(party, { reason, detail, priority = "normal", goals = null, ignoreCapacity = false }) {
    if (this.#emergencyHold.has(party.party_id) && priority !== "emergency") {
      return null; // 紧急疏散压过普通推荐
    }
    const remaining = goals ?? this.#remainingGoals(party);
    const accessibleOnly = party.accessibility_needs.length > 0;
    const avoidPenalties = priority === "emergency" ? new Map() : this.#avoidPenalties(party.party_id);
    // 当前计划正在经过的路段不算“重回”，不施加惩罚；
    // 惩罚只针对刚被迫离开的路段，避免把队伍反复导向新拥堵点。
    for (const leg of this.#remainingLegs(party)) {
      avoidPenalties.delete(leg);
    }
    const routePlanId = `route-${party.party_id}`;
    const decisionId = this.#decisionIds();
    let plan;
    try {
      plan = this.#planner.planJourney({
        from: party.current_node,
        goals: remaining,
        accessibleOnly,
        avoidPenalties,
        ignoreCapacity,
      });
    } catch (err) {
      if (err instanceof RouteError) {
        this.#decisions.set(decisionId, this.#decisionRecord({
          decisionId, party, routePlanId, planVersion: null, reason, detail, priority,
          chosen: null, avoided: [...avoidPenalties.keys()], outcome: `no_feasible_route: ${err.message}`,
        }));
        return null;
      }
      throw err;
    }
    const version = this.#store.latestVersion("route_plan", routePlanId) + 1;
    const event = this.#store.append({
      event_id: this.#ids(),
      event_type: "ROUTE_REVISED",
      aggregate_type: "route_plan",
      aggregate_id: routePlanId,
      occurred_at: this.#now(),
      version,
      summary: `${REVISION_REASONS[reason]}：${detail}`,
      payload: {
        party_id: party.party_id,
        legs: plan.legs,
        nodes: plan.nodes,
        goals: remaining,
        eta_minutes: plan.eta_minutes,
        reason,
        reason_detail: detail,
        priority,
        decision_id: decisionId,
      },
    });
    party.current_plan = { version, legs: plan.legs, nodes: plan.nodes };
    this.#decisions.set(decisionId, this.#decisionRecord({
      decisionId, party, routePlanId, planVersion: version, reason, detail, priority,
      chosen: { legs: plan.legs, nodes: plan.nodes, eta_minutes: plan.eta_minutes, goals: remaining },
      avoided: [...avoidPenalties.keys()], outcome: "revised",
    }));
    return event;
  }

  /** 决策记录：快照当时的客流、预警、施工与人工干预，供值班回放。 */
  #decisionRecord({ decisionId, party, routePlanId, planVersion, reason, detail, priority, chosen, avoided, outcome }) {
    const conditions = this.#conditions.snapshot();
    return {
      decision_id: decisionId,
      at: this.#now(),
      party_id: party.party_id,
      route_plan_id: routePlanId,
      plan_version: planVersion,
      reason,
      reason_detail: detail,
      priority,
      outcome,
      inputs: {
        crowd_flow: conditions.load,
        congestion: conditions.congestion,
        construction: conditions.closures,
        weather_holds: conditions.weather_holds,
        active_alerts: this.#incidents.active(),
        manual_interventions: [...this.#manualLog],
      },
      avoided_segments: avoided,
      chosen,
    };
  }

  // ---------- 游客视图与值班回放 ----------

  /** 游客可见：当前路线、设备交接、预计等待变化。 */
  visitorView(partyId) {
    const party = this.#party(partyId);
    const routePlanId = `route-${partyId}`;
    const revisions = this.#store.ofAggregate("route_plan", routePlanId);
    const latest = revisions.at(-1) ?? null;
    const assignment = this.#fleet.assignmentOf(partyId);
    const handovers = this.#store
      .ofType("DEVICE_ASSIGNED")
      .filter((event) => event.payload?.party_id === partyId && event.payload?.status === "assigned" && event.payload?.supersedes)
      .map((event) => ({
        at: event.occurred_at,
        from_device: event.payload.supersedes,
        to_device: event.aggregate_id,
        reason: event.payload.reason,
      }));
    const waitChanges = revisions.map((revision, index) => ({
      plan_version: revision.version,
      at: revision.occurred_at,
      reason: revision.payload.reason,
      eta_minutes: revision.payload.eta_minutes,
      delta_minutes:
        index === 0 ? 0 : Math.round((revision.payload.eta_minutes - revisions[index - 1].payload.eta_minutes) * 10) / 10,
    }));
    let liveEta = null;
    try {
      liveEta = this.#planner.planJourney({
        from: party.current_node,
        goals: this.#remainingGoals(party),
        accessibleOnly: party.accessibility_needs.length > 0,
      }).eta_minutes;
    } catch (err) {
      if (!(err instanceof RouteError)) throw err;
    }
    return {
      party_id: party.party_id,
      status: party.status,
      entry_slot: party.entry_slot,
      current_node: party.current_node,
      remaining_goals: this.#remainingGoals(party),
      current_route: latest
        ? {
            plan_version: latest.version,
            priority: latest.payload.priority,
            legs: latest.payload.legs.map((segmentId) => {
              const segment = this.#network.segment(segmentId);
              return {
                segment_id: segmentId,
                from: segment.from,
                to: segment.to,
                from_name: this.#network.node(segment.from).name ?? segment.from,
                to_name: this.#network.node(segment.to).name ?? segment.to,
              };
            }),
            eta_minutes: latest.payload.eta_minutes,
          }
        : null,
      device: assignment
        ? {
            device_id: assignment.device_id,
            kind: assignment.kind,
            label: assignment.label,
            battery_pct: this.#telemetry.snapshot(assignment.device_id).battery_pct,
          }
        : null,
      handovers,
      wait_changes: waitChanges,
      live_eta_minutes: liveEta,
    };
  }

  /** 值班回放：一次调度用了哪些客流、预警、施工与人工干预信息。 */
  replayDecision(decisionId) {
    const decision = this.#decisions.get(decisionId);
    if (!decision) throw new DispatchError(`未知调度决策：${decisionId}`);
    return decision;
  }

  replayRoutePlan(routePlanId) {
    return {
      events: this.#store.ofAggregate("route_plan", routePlanId),
      decisions: [...this.#decisions.values()].filter((decision) => decision.route_plan_id === routePlanId),
    };
  }
}
