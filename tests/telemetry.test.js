import assert from "node:assert/strict";
import test from "node:test";

import { TelemetryIngestor } from "../src/telemetry.js";

function msg(overrides) {
  return {
    message_id: "m-1",
    device_seq: 1,
    sent_at: "2026-10-04T09:00:00+08:00",
    kind: "heartbeat",
    ...overrides,
  };
}

test("乱序消息先缓存，缺口补齐后按序应用", () => {
  const telemetry = new TelemetryIngestor();
  const late = telemetry.ingest("R1", msg({ message_id: "m-2", device_seq: 2, kind: "location", node: "falls-view" }));
  assert.equal(late.status, "buffered");
  assert.equal(telemetry.snapshot("R1").location, null);

  const first = telemetry.ingest("R1", msg({ message_id: "m-1", device_seq: 1, kind: "battery", battery_pct: 80 }));
  assert.equal(first.status, "applied");
  assert.equal(first.applied, 2); // 本条 + 缓存的 seq 2
  assert.equal(telemetry.snapshot("R1").location.node, "falls-view");
  assert.equal(telemetry.snapshot("R1").last_seq, 2);
});

test("重连补发的消息按 message_id 与 device_seq 去重", () => {
  const telemetry = new TelemetryIngestor();
  telemetry.ingest("R1", msg({ message_id: "m-1", device_seq: 1 }));
  assert.equal(telemetry.ingest("R1", msg({ message_id: "m-1", device_seq: 1 })).status, "duplicate");
  // 同一序号换发新标识（设备重发队列）同样只计一次
  assert.equal(telemetry.ingest("R1", msg({ message_id: "m-1b", device_seq: 1 })).status, "duplicate");
  assert.equal(telemetry.snapshot("R1").last_seq, 1);
});

test("低电量信号只发一次，电量回升后重新武装", () => {
  const signals = [];
  const telemetry = new TelemetryIngestor({ lowBatteryPct: 20 });
  telemetry.onSignal((signal) => signals.push(signal));
  telemetry.ingest("R1", msg({ message_id: "m-1", device_seq: 1, kind: "battery", battery_pct: 15 }));
  telemetry.ingest("R1", msg({ message_id: "m-2", device_seq: 2, kind: "battery", battery_pct: 12 }));
  assert.equal(signals.filter((s) => s.type === "low_battery").length, 1);
  telemetry.ingest("R1", msg({ message_id: "m-3", device_seq: 3, kind: "battery", battery_pct: 55 }));
  telemetry.ingest("R1", msg({ message_id: "m-4", device_seq: 4, kind: "battery", battery_pct: 9 }));
  assert.equal(signals.filter((s) => s.type === "low_battery").length, 2);
});

test("断网超时标记离线，重连后发出信号且补发消息去重", () => {
  const signals = [];
  const telemetry = new TelemetryIngestor({ offlineAfterMs: 60_000 });
  telemetry.onSignal((signal) => signals.push(signal));
  telemetry.ingest("R1", msg({ message_id: "m-1", device_seq: 1, kind: "location", node: "escalator-top" }));

  const offline = telemetry.sweepOffline("2026-10-04T09:02:00+08:00");
  assert.deepEqual(offline, ["R1"]);
  assert.equal(telemetry.snapshot("R1").online, false);

  // 重连：先补发旧消息（去重），再上报新位置
  assert.equal(telemetry.ingest("R1", msg({ message_id: "m-1", device_seq: 1, kind: "location", node: "escalator-top" })).status, "duplicate");
  telemetry.ingest("R1", msg({ message_id: "m-2", device_seq: 2, kind: "location", node: "falls-view" }));
  assert.equal(telemetry.snapshot("R1").online, true);
  assert.equal(telemetry.snapshot("R1").location.node, "falls-view");
  assert.ok(signals.some((s) => s.type === "device_offline"));
  assert.ok(signals.some((s) => s.type === "device_reconnected"));
});
