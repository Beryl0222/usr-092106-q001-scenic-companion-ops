export class ConsentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConsentError";
  }
}

/** 需要分别取得明示同意的处理范围；设备默认设置不构成授权。 */
export const CONSENT_SCOPES = Object.freeze({
  VIDEO_RECORDING: "video_recording",
  PHOTO_CAPTURE: "photo_capture",
  TRAVELOGUE_GENERATION: "travelogue_generation",
});

const SCOPE_LABELS = Object.freeze({
  [CONSENT_SCOPES.VIDEO_RECORDING]: "录像",
  [CONSENT_SCOPES.PHOTO_CAPTURE]: "照片",
  [CONSENT_SCOPES.TRAVELOGUE_GENERATION]: "游记生成",
});

function assertScope(scope) {
  if (!Object.values(CONSENT_SCOPES).includes(scope)) {
    throw new ConsentError(`未知授权范围：${scope}`);
  }
}

/**
 * 授权服务：每个范围只看游客最近一次明示决定，默认拒绝。
 * 决定写入 CONSENT_CHANGED 事件（visitor_party 聚合），同时落安全审计；
 * 撤回后审计条目保留，后续处理一律被闸门拦下。
 */
export class ConsentService {
  #store;
  #ids;
  #now;
  #audit;
  #listeners = [];

  constructor({ store, ids, now, audit }) {
    this.#store = store;
    this.#ids = ids;
    this.#now = now;
    this.#audit = audit;
  }

  /** 订阅授权变化（如媒体流水线据此停止待处理任务）。 */
  onDecision(listener) {
    this.#listeners.push(listener);
  }

  grant(partyId, scope, { by = "visitor", reason = "" } = {}) {
    return this.#record(partyId, scope, "granted", { by, reason });
  }

  withdraw(partyId, scope, { by = "visitor", reason = "" } = {}) {
    return this.#record(partyId, scope, "withdrawn", { by, reason });
  }

  #record(partyId, scope, decision, { by, reason }) {
    assertScope(scope);
    const version = this.#store.latestVersion("visitor_party", partyId) + 1;
    if (version === 1) {
      throw new ConsentError(`未登记的同行组：${partyId}`);
    }
    const event = this.#store.append({
      event_id: this.#ids(),
      event_type: "CONSENT_CHANGED",
      aggregate_type: "visitor_party",
      aggregate_id: partyId,
      occurred_at: this.#now(),
      version,
      summary: `${decision === "granted" ? "同意" : "撤回"}${SCOPE_LABELS[scope]}授权`,
      payload: { scope, decision, by, reason },
    });
    this.#audit.record({
      kind: "consent_decision",
      party_id: partyId,
      scope,
      decision,
      by,
      reason,
      at: event.occurred_at,
    });
    for (const listener of this.#listeners) {
      listener({ party_id: partyId, scope, decision, at: event.occurred_at });
    }
    return event;
  }

  /** 当前是否允许处理：默认拒绝，只看 at 之前最近一次明示决定。 */
  allows(partyId, scope, at = null) {
    assertScope(scope);
    const decisions = this.#store
      .ofAggregate("visitor_party", partyId)
      .filter((event) => event.event_type === "CONSENT_CHANGED" && event.payload?.scope === scope);
    const effective = at === null ? decisions : decisions.filter((event) => event.occurred_at <= at);
    const latest = effective.at(-1);
    return latest?.payload?.decision === "granted";
  }

  /** 处理闸门：媒体流水线每次处理前调用；未授权即拒绝并留审计。 */
  requireProcessing(partyId, scope) {
    const allowed = this.allows(partyId, scope);
    this.#audit.record({
      kind: "processing_gate",
      party_id: partyId,
      scope,
      allowed,
      at: this.#now(),
    });
    if (!allowed) {
      throw new ConsentError(`同行组 ${partyId} 未授权 ${scope}，停止后续处理`);
    }
  }
}
