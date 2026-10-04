import assert from "node:assert/strict";
import test from "node:test";

import { EventStore, EventStoreError } from "../src/event-store.js";
import { createIdFactory, createMutableClock } from "../src/util.js";

function setup() {
  const ids = createIdFactory("evt");
  const now = createMutableClock("2026-10-04T09:00:00+08:00");
  return { store: new EventStore(), ids, now };
}

function envelope(ids, now, overrides = {}) {
  return {
    event_id: ids(),
    event_type: "VISIT_RESERVED",
    aggregate_type: "visitor_party",
    aggregate_id: "party-1",
    occurred_at: now(),
    version: 1,
    summary: "预约伴游",
    ...overrides,
  };
}

test("事件按聚合从版本 1 递增", () => {
  const { store, ids, now } = setup();
  store.append(envelope(ids, now));
  store.append(envelope(ids, now, { event_type: "CONSENT_CHANGED", version: 2, summary: "同意录像授权" }));
  assert.equal(store.latestVersion("visitor_party", "party-1"), 2);
  assert.equal(store.ofAggregate("visitor_party", "party-1").length, 2);
});

test("版本跳号或回退被拒绝", () => {
  const { store, ids, now } = setup();
  store.append(envelope(ids, now));
  assert.throws(() => store.append(envelope(ids, now, { version: 3 })), EventStoreError);
  assert.throws(() => store.append(envelope(ids, now, { version: 1 })), /期望版本 2/);
});

test("事件标识不可重复", () => {
  const { store, ids, now } = setup();
  const first = envelope(ids, now);
  store.append(first);
  assert.throws(() => store.append({ ...first, summary: "重复标识" }), /事件标识重复/);
});

test("缺少信封字段被拒绝", () => {
  const { store, ids, now } = setup();
  const bad = envelope(ids, now);
  delete bad.summary;
  assert.throws(() => store.append(bad), /缺少字段：summary/);
});

test("事件写入后不可原地改写", () => {
  const { store, ids, now } = setup();
  const record = store.append(envelope(ids, now, { payload: { size: 4 } }));
  assert.throws(() => {
    record.summary = "篡改";
  }, TypeError);
  assert.throws(() => {
    record.payload.size = 99;
  }, TypeError);
});
