import { validateEvent } from "./validator.js";
import { deepFreeze } from "./util.js";

export class EventStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "EventStoreError";
  }
}

/**
 * 追加式领域事件存储。
 * 遵循 contracts/domain.schema.json：信封字段不变，version 从 1 起按聚合递增；
 * 事件一旦被接收即不可原地改写，业务更正只能追加后继记录。
 */
export class EventStore {
  #events = [];
  #ids = new Set();
  #latestVersion = new Map();

  append(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) {
      throw new EventStoreError(`事件信封不合法：${errors.join("；")}`);
    }
    if (this.#ids.has(event.event_id)) {
      throw new EventStoreError(`事件标识重复：${event.event_id}`);
    }
    const key = `${event.aggregate_type}/${event.aggregate_id}`;
    const expected = (this.#latestVersion.get(key) ?? 0) + 1;
    if (event.version !== expected) {
      throw new EventStoreError(`聚合 ${key} 期望版本 ${expected}，收到 ${event.version}`);
    }
    const record = deepFreeze(structuredClone(event));
    this.#events.push(record);
    this.#ids.add(record.event_id);
    this.#latestVersion.set(key, record.version);
    return record;
  }

  all() {
    return [...this.#events];
  }

  ofAggregate(aggregateType, aggregateId) {
    return this.#events.filter(
      (event) => event.aggregate_type === aggregateType && event.aggregate_id === aggregateId,
    );
  }

  ofType(eventType) {
    return this.#events.filter((event) => event.event_type === eventType);
  }

  latestVersion(aggregateType, aggregateId) {
    return this.#latestVersion.get(`${aggregateType}/${aggregateId}`) ?? 0;
  }
}
