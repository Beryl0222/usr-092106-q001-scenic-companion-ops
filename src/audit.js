import { deepFreeze } from "./util.js";

/**
 * 安全审计日志：只追加、不删除。
 * 授权撤回后，审计条目仍须保留，用于事后追溯处理行为是否越权。
 */
export class AuditLog {
  #entries = [];

  record(entry) {
    const frozen = deepFreeze({ ...entry });
    this.#entries.push(frozen);
    return frozen;
  }

  /** 按字段等值过滤，例如 entries({ party_id: "p-1", kind: "processing_gate" })。 */
  entries(filter = {}) {
    const keys = Object.keys(filter);
    return this.#entries.filter((entry) => keys.every((key) => entry[key] === filter[key]));
  }
}
