export class IncidentError extends Error {
  constructor(message) {
    super(message);
    this.name = "IncidentError";
  }
}

export const INCIDENT_KINDS = Object.freeze([
  "construction",
  "weather",
  "congestion",
  "device_failure",
  "emergency",
]);

export const SEVERITY = Object.freeze({ INFO: 1, WARNING: 2, CRITICAL: 3, EMERGENCY: 4 });

/**
 * 现场告警：施工、暴雨、拥堵、设备故障、紧急疏散统一进 incident 聚合，
 * 每次升级/解除都追加 INCIDENT_ESCALATED 后继记录，保留完整处置链。
 */
export class IncidentService {
  #store;
  #ids;
  #incidentIds;
  #now;

  constructor({ store, ids, incidentIds, now }) {
    this.#store = store;
    this.#ids = ids;
    this.#incidentIds = incidentIds;
    this.#now = now;
  }

  raise({ kind, severity, summary, segment_ids = [], party_ids = [], details = {} }) {
    if (!INCIDENT_KINDS.includes(kind)) {
      throw new IncidentError(`未知告警类型：${kind}`);
    }
    if (!Object.values(SEVERITY).includes(severity)) {
      throw new IncidentError(`未知告警级别：${severity}`);
    }
    const incidentId = this.#incidentIds();
    this.#store.append({
      event_id: this.#ids(),
      event_type: "INCIDENT_ESCALATED",
      aggregate_type: "incident",
      aggregate_id: incidentId,
      occurred_at: this.#now(),
      version: 1,
      summary,
      payload: { kind, severity, status: "active", segment_ids, party_ids, details },
    });
    return incidentId;
  }

  escalate(incidentId, severity, note) {
    const latest = this.#latest(incidentId);
    if (latest?.payload?.status !== "active") {
      throw new IncidentError(`告警 ${incidentId} 不在处置中，不能升级`);
    }
    return this.#append(incidentId, { ...latest.payload, severity, status: "active", details: { ...latest.payload.details, note } }, `告警升级：${note}`);
  }

  clear(incidentId, note = "") {
    const latest = this.#latest(incidentId);
    if (!latest) {
      throw new IncidentError(`未知告警：${incidentId}`);
    }
    if (latest.payload.status === "cleared") {
      return latest;
    }
    return this.#append(incidentId, { ...latest.payload, status: "cleared", details: { ...latest.payload.details, note } }, `告警解除：${note || latest.summary}`);
  }

  #append(incidentId, payload, summary) {
    return this.#store.append({
      event_id: this.#ids(),
      event_type: "INCIDENT_ESCALATED",
      aggregate_type: "incident",
      aggregate_id: incidentId,
      occurred_at: this.#now(),
      version: this.#store.latestVersion("incident", incidentId) + 1,
      summary,
      payload,
    });
  }

  #latest(incidentId) {
    return this.#store.ofAggregate("incident", incidentId).at(-1) ?? null;
  }

  /** 当前处置中的告警（按各聚合最新状态判定）。 */
  active() {
    const latestByIncident = new Map();
    for (const event of this.#store.ofType("INCIDENT_ESCALATED")) {
      latestByIncident.set(event.aggregate_id, event);
    }
    return [...latestByIncident.values()]
      .filter((event) => event.payload?.status === "active")
      .map((event) => ({
        incident_id: event.aggregate_id,
        kind: event.payload.kind,
        severity: event.payload.severity,
        segment_ids: event.payload.segment_ids,
        party_ids: event.payload.party_ids,
        raised_at: event.occurred_at,
      }));
  }

  activeEmergencies() {
    return this.active().filter((incident) => incident.severity === SEVERITY.EMERGENCY);
  }
}
