export class FleetError extends Error {
  constructor(message) {
    super(message);
    this.name = "FleetError";
  }
}

export const DEVICE_KINDS = Object.freeze(["companion_robot", "exoskeleton", "human_team"]);

/**
 * 伴游资源车队：伴游机器人、外骨骼装备与人工讲解队统一建模。
 * 指派与释放都写 DEVICE_ASSIGNED 事件（companion_device 聚合），
 * 交接通过后继记录的 supersedes 串联，不原地改写。
 */
export class Fleet {
  #store;
  #ids;
  #now;
  #devices = new Map();

  constructor({ store, ids, now }) {
    this.#store = store;
    this.#ids = ids;
    this.#now = now;
  }

  register({ device_id, kind, capabilities = [], content_versions = [], label = device_id }) {
    if (!DEVICE_KINDS.includes(kind)) {
      throw new FleetError(`未知设备类型：${kind}`);
    }
    if (this.#devices.has(device_id)) {
      throw new FleetError(`设备已登记：${device_id}`);
    }
    this.#devices.set(device_id, {
      device_id,
      kind,
      label,
      capabilities: new Set(capabilities),
      content_versions: [...content_versions],
      assigned_party: null,
      failed: false,
    });
  }

  #require(deviceId) {
    const device = this.#devices.get(deviceId);
    if (!device) {
      throw new FleetError(`未登记设备：${deviceId}`);
    }
    return device;
  }

  /** 指派设备服务同行组；校验讲解内容版本与占用状态。 */
  assign(deviceId, partyId, { contentVersion = null, reason, supersedes = null }) {
    const device = this.#require(deviceId);
    if (device.failed) {
      throw new FleetError(`设备 ${deviceId} 已故障，不能指派`);
    }
    if (device.assigned_party !== null && device.assigned_party !== partyId) {
      throw new FleetError(`设备 ${deviceId} 正在服务 ${device.assigned_party}`);
    }
    if (contentVersion !== null && !device.content_versions.includes(contentVersion)) {
      throw new FleetError(`设备 ${deviceId} 不支持讲解内容版本 ${contentVersion}`);
    }
    const event = this.#store.append({
      event_id: this.#ids(),
      event_type: "DEVICE_ASSIGNED",
      aggregate_type: "companion_device",
      aggregate_id: deviceId,
      occurred_at: this.#now(),
      version: this.#store.latestVersion("companion_device", deviceId) + 1,
      summary: `指派 ${device.label} 服务同行组 ${partyId}`,
      payload: { party_id: partyId, status: "assigned", content_version: contentVersion, reason, supersedes },
    });
    device.assigned_party = partyId;
    return event;
  }

  release(deviceId, { reason }) {
    const device = this.#require(deviceId);
    const partyId = device.assigned_party;
    const event = this.#store.append({
      event_id: this.#ids(),
      event_type: "DEVICE_ASSIGNED",
      aggregate_type: "companion_device",
      aggregate_id: deviceId,
      occurred_at: this.#now(),
      version: this.#store.latestVersion("companion_device", deviceId) + 1,
      summary: `释放 ${device.label}（${reason}）`,
      payload: { party_id: partyId, status: "released", reason },
    });
    device.assigned_party = null;
    return event;
  }

  markFailed(deviceId) {
    this.#require(deviceId).failed = true;
  }

  markRecovered(deviceId) {
    this.#require(deviceId).failed = false;
  }

  has(deviceId) {
    return this.#devices.has(deviceId);
  }

  partyOf(deviceId) {
    return this.#require(deviceId).assigned_party;
  }

  assignmentOf(partyId) {
    for (const device of this.#devices.values()) {
      if (device.assigned_party === partyId) {
        return this.get(device.device_id);
      }
    }
    return null;
  }

  get(deviceId) {
    const device = this.#require(deviceId);
    return {
      device_id: device.device_id,
      kind: device.kind,
      label: device.label,
      capabilities: [...device.capabilities],
      content_versions: [...device.content_versions],
      assigned_party: device.assigned_party,
      failed: device.failed,
    };
  }

  /**
   * 选择接替资源：须覆盖同行组无障碍需求与讲解内容版本；
   * 优先同类型设备，其次其他可用设备，最后人工讲解队。
   */
  selectReplacement({ needs = [], contentVersion = null, exclude = null, preferKind = null }) {
    const usable = (device) =>
      !device.failed &&
      device.device_id !== exclude &&
      device.assigned_party === null &&
      needs.every((need) => device.capabilities.has(need)) &&
      (contentVersion === null || device.content_versions.includes(contentVersion));
    const pool = [...this.#devices.values()].filter(usable);
    const picked =
      pool.find((device) => device.kind === preferKind) ??
      pool.find((device) => device.kind !== "human_team") ??
      pool.find((device) => device.kind === "human_team") ??
      null;
    return picked ? this.get(picked.device_id) : null;
  }
}
