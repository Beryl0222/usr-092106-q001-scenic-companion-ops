export class TelemetryError extends Error {
  constructor(message) {
    super(message);
    this.name = "TelemetryError";
  }
}

export const TELEMETRY_KINDS = Object.freeze(["location", "battery", "heartbeat"]);

/**
 * 设备遥测接入。
 * 设备断网重连后可能补发或乱序上报定位与电量：
 * - 按 message_id 与 device_seq 双重去重，重放消息只计一次；
 * - 出现序号空洞时先缓存，缺口补齐后按序应用；
 * - 电量越过阈值时向调度发出一次信号，回升后重新武装。
 */
export class TelemetryIngestor {
  #states = new Map();
  #lowBatteryPct;
  #offlineAfterMs;
  #listeners = [];

  constructor({ lowBatteryPct = 20, offlineAfterMs = 60_000 } = {}) {
    this.#lowBatteryPct = lowBatteryPct;
    this.#offlineAfterMs = offlineAfterMs;
  }

  onSignal(listener) {
    this.#listeners.push(listener);
  }

  #emit(signal) {
    for (const listener of this.#listeners) {
      listener(signal);
    }
  }

  #stateFor(deviceId) {
    if (!this.#states.has(deviceId)) {
      this.#states.set(deviceId, {
        lastSeq: 0,
        seenIds: new Set(),
        buffer: new Map(),
        online: true,
        lastSeenAt: null,
        location: null,
        batteryPct: null,
        lowBatterySignalled: false,
      });
    }
    return this.#states.get(deviceId);
  }

  /**
   * message: { message_id, device_seq, sent_at, kind, node?, battery_pct? }
   * 返回 { status: "applied" | "duplicate" | "buffered", ... }
   */
  ingest(deviceId, message) {
    const { message_id, device_seq, sent_at, kind } = message ?? {};
    if (!message_id || !Number.isInteger(device_seq) || device_seq < 1 || !sent_at) {
      throw new TelemetryError("遥测消息缺少 message_id / device_seq / sent_at");
    }
    if (!TELEMETRY_KINDS.includes(kind)) {
      throw new TelemetryError(`未知遥测类型：${kind}`);
    }
    const state = this.#stateFor(deviceId);
    if (state.seenIds.has(message_id)) {
      return { status: "duplicate", reason: "message_id" };
    }
    state.seenIds.add(message_id);
    if (device_seq <= state.lastSeq) {
      return { status: "duplicate", reason: "device_seq" };
    }
    if (device_seq > state.lastSeq + 1) {
      state.buffer.set(device_seq, message);
      return { status: "buffered", gap: device_seq - state.lastSeq - 1 };
    }
    const applied = this.#drain(deviceId, state, message);
    return { status: "applied", applied };
  }

  /** 应用本条并冲刷缓存中连续的后继消息，返回应用条数。 */
  #drain(deviceId, state, message) {
    let applied = 0;
    let current = message;
    while (current) {
      state.lastSeq = current.device_seq;
      this.#apply(deviceId, state, current);
      applied += 1;
      const nextSeq = state.lastSeq + 1;
      current = state.buffer.get(nextSeq) ?? null;
      if (current) {
        state.buffer.delete(nextSeq);
      }
    }
    return applied;
  }

  #apply(deviceId, state, message) {
    if (!state.online) {
      state.online = true;
      this.#emit({ type: "device_reconnected", device_id: deviceId, at: message.sent_at });
    }
    state.lastSeenAt = message.sent_at;
    if (message.kind === "location") {
      state.location = { node: message.node, at: message.sent_at };
    }
    if (message.kind === "battery") {
      state.batteryPct = message.battery_pct;
      if (message.battery_pct <= this.#lowBatteryPct && !state.lowBatterySignalled) {
        state.lowBatterySignalled = true;
        this.#emit({
          type: "low_battery",
          device_id: deviceId,
          battery_pct: message.battery_pct,
          at: message.sent_at,
        });
      } else if (message.battery_pct > this.#lowBatteryPct) {
        state.lowBatterySignalled = false;
      }
    }
  }

  /** 巡检离线设备：超过 offlineAfterMs 未上报即标记离线并发信号。 */
  sweepOffline(nowIso) {
    const nowMs = new Date(nowIso).getTime();
    const offline = [];
    for (const [deviceId, state] of this.#states) {
      if (!state.online || state.lastSeenAt === null) continue;
      if (nowMs - new Date(state.lastSeenAt).getTime() > this.#offlineAfterMs) {
        state.online = false;
        offline.push(deviceId);
        this.#emit({ type: "device_offline", device_id: deviceId, at: nowIso });
      }
    }
    return offline;
  }

  snapshot(deviceId) {
    const state = this.#states.get(deviceId);
    if (!state) {
      return { online: false, battery_pct: null, location: null, last_seq: 0, buffered: [] };
    }
    return {
      online: state.online,
      battery_pct: state.batteryPct,
      location: state.location ? { ...state.location } : null,
      last_seq: state.lastSeq,
      buffered: [...state.buffer.keys()].sort((a, b) => a - b),
    };
  }
}
