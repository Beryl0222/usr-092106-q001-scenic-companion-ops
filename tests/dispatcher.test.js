import assert from "node:assert/strict";
import test from "node:test";

import { SEVERITY } from "../src/incidents.js";
import { FleetError } from "../src/fleet.js";
import { DispatchError } from "../src/dispatcher.js";
import { buildOps, registerHumanTeam, registerRobot, reserveMainParty } from "./fixtures.js";

const SLOT = { start: "2026-10-04T09:30:00+08:00", end: "2026-10-04T10:00:00+08:00" };

function locationMsg(seq, node) {
  return { message_id: `m-${seq}`, device_seq: seq, sent_at: "2026-10-04T09:05:00+08:00", kind: "location", node };
}

test("预约生成初始游程，设备按内容版本与能力指派", () => {
  const ops = buildOps();
  const view = reserveMainParty(ops);
  assert.deepEqual(
    view.current_route.legs.map((leg) => leg.segment_id),
    ["s1", "s2", "s4", "s5"],
  );
  assert.equal(view.current_route.eta_minutes, 31);
  assert.equal(view.entry_slot.start, SLOT.start);

  registerRobot(ops, "R1");
  ops.dispatch.assignDevice("R1", "party-1");
  assert.equal(ops.dispatch.visitorView("party-1").device.device_id, "R1");

  // 讲解内容版本不匹配的设备不能指派
  registerRobot(ops, "R9", ["narr-v2"]);
  assert.throws(() => ops.dispatch.assignDevice("R9", "party-1"), FleetError);

  // 事件链：VISIT_RESERVED → ROUTE_REVISED → DEVICE_ASSIGNED 均可追溯
  assert.equal(ops.store.ofAggregate("visitor_party", "party-1")[0].version, 1);
  assert.equal(ops.store.ofAggregate("route_plan", "route-party-1")[0].payload.reason, "initial");
  assert.equal(ops.store.ofAggregate("companion_device", "R1")[0].payload.status, "assigned");
});

test("分时入园时段不合法被拒绝", () => {
  const ops = buildOps();
  assert.throws(
    () =>
      ops.dispatch.reserveVisit({
        party_id: "party-x",
        size: 2,
        entry_slot: { start: "2026-10-04T10:00:00+08:00", end: "2026-10-04T09:00:00+08:00" },
        entry_node: "gate-main",
      }),
    DispatchError,
  );
});

test("施工封闭触发改线，原因与决策输入可回放", () => {
  const ops = buildOps();
  reserveMainParty(ops);
  const { revisions } = ops.dispatch.reportConstruction("s2", "扶梯路段临时施工");
  assert.equal(revisions.length, 1);
  const revision = revisions[0];
  assert.equal(revision.payload.reason, "construction_closure");
  assert.match(revision.summary, /路段施工封闭/);
  assert.deepEqual(revision.payload.legs, ["s1", "s7", "s11", "s4", "s5"]);

  // 值班回放：当时用了哪些施工、客流与告警信息
  const replay = ops.dispatch.replayDecision(revision.payload.decision_id);
  assert.equal(replay.inputs.construction.s2, "construction");
  assert.ok(replay.inputs.active_alerts.some((alert) => alert.kind === "construction"));
  assert.equal(replay.chosen.eta_minutes, 34);

  const view = ops.dispatch.visitorView("party-1");
  assert.equal(view.wait_changes.length, 2);
  assert.equal(view.wait_changes[1].delta_minutes, 3); // 31 → 34
});

test("拥堵改线后冷却期内不把同一队伍导回刚避开的拥堵点", () => {
  const ops = buildOps();
  reserveMainParty(ops);
  registerRobot(ops, "R1");
  ops.dispatch.assignDevice("R1", "party-1");
  ops.dispatch.ingestTelemetry("R1", locationMsg(1, "falls-view"));

  // s4 突发拥堵：改走充电点一侧
  let [revision] = ops.dispatch.updateCrowdLoad("s4", 40);
  assert.equal(revision.payload.reason, "congestion");
  assert.deepEqual(revision.payload.legs, ["s9", "s10", "s5"]);

  // s4 回落但 s10 又拥堵：朴素规划会把队伍导回 s4，改线惩罚阻止这次反复
  ops.dispatch.updateCrowdLoad("s4", 5);
  [revision] = ops.dispatch.updateCrowdLoad("s10", 16);
  assert.deepEqual(revision.payload.legs, ["s9", "s10", "s5"]);
  const replay = ops.dispatch.replayDecision(revision.payload.decision_id);
  assert.ok(replay.avoided_segments.includes("s4"));

  // 冷却期过后，s4 重新成为可选
  ops.now.advance(21 * 60_000);
  ops.dispatch.updateCrowdLoad("s10", 0);
  [revision] = ops.dispatch.updateCrowdLoad("s10", 16);
  assert.deepEqual(revision.payload.legs, ["s4", "s5"]);
});

test("暴雨预警管制路段并改线", () => {
  const ops = buildOps();
  ops.dispatch.reserveVisit({
    party_id: "party-2",
    size: 2,
    accessibility_needs: [],
    entry_slot: SLOT,
    entry_node: "gate-main",
    exit_node: "exit-west",
    visit_goals: ["water-curtain", "rhino-pool"],
  });
  assert.deepEqual(
    ops.dispatch.visitorView("party-2").current_route.legs.map((leg) => leg.segment_id),
    ["s1", "s2", "s3", "s6", "s5"],
  );

  const { revisions } = ops.dispatch.reportWeatherAlert(["s3"], "水帘洞暴雨预警，路段管制");
  assert.equal(revisions[0].payload.reason, "weather_warning");
  assert.ok(!revisions[0].payload.legs.includes("s3"));
  assert.equal(ops.conditions.isBlocked("s3"), true);
});

test("设备低电量：有接替资源时无缝交接", () => {
  const ops = buildOps();
  reserveMainParty(ops);
  registerRobot(ops, "R1");
  registerRobot(ops, "R2");
  ops.dispatch.assignDevice("R1", "party-1");

  ops.dispatch.ingestTelemetry("R1", {
    message_id: "b-1",
    device_seq: 1,
    sent_at: "2026-10-04T09:10:00+08:00",
    kind: "battery",
    battery_pct: 15,
  });

  const view = ops.dispatch.visitorView("party-1");
  assert.equal(view.device.device_id, "R2");
  assert.deepEqual(view.handovers, [
    { at: view.handovers[0].at, from_device: "R1", to_device: "R2", reason: "low_battery_handover" },
  ]);
  assert.equal(ops.fleet.get("R1").assigned_party, null);
  // 游程不因交接改变
  assert.equal(ops.store.ofAggregate("route_plan", "route-party-1").length, 1);
});

test("设备低电量：无接替资源时改线经过充电点", () => {
  const ops = buildOps();
  reserveMainParty(ops);
  registerRobot(ops, "R1");
  ops.dispatch.assignDevice("R1", "party-1");

  ops.dispatch.ingestTelemetry("R1", {
    message_id: "b-1",
    device_seq: 1,
    sent_at: "2026-10-04T09:10:00+08:00",
    kind: "battery",
    battery_pct: 10,
  });

  const revisions = ops.store.ofAggregate("route_plan", "route-party-1");
  const latest = revisions.at(-1);
  assert.equal(latest.payload.reason, "low_battery");
  assert.ok(latest.payload.nodes.includes("charge-1"));
});

test("设备故障无缝转交人工讲解队，游程不中断", () => {
  const ops = buildOps();
  reserveMainParty(ops);
  registerRobot(ops, "R1");
  registerHumanTeam(ops, "H1");
  ops.dispatch.assignDevice("R1", "party-1");

  const { incident_id, handover } = ops.dispatch.reportDeviceFailure("R1", "驱动轮故障");
  assert.equal(handover.payload.supersedes, "R1");
  assert.equal(handover.payload.reason, "device_failure_handover");

  const view = ops.dispatch.visitorView("party-1");
  assert.equal(view.device.kind, "human_team");
  assert.equal(view.device.device_id, "H1");
  assert.equal(view.handovers.length, 1);
  // 游程保持，不额外改线
  assert.equal(ops.store.ofAggregate("route_plan", "route-party-1").length, 1);
  const incident = ops.incidents.active().find((i) => i.incident_id === incident_id);
  assert.equal(incident.kind, "device_failure");
});

test("设备故障且无接替资源时告警升级为紧急", () => {
  const ops = buildOps();
  reserveMainParty(ops);
  registerRobot(ops, "R1");
  ops.dispatch.assignDevice("R1", "party-1");

  const { incident_id, handover } = ops.dispatch.reportDeviceFailure("R1", "主板烧毁");
  assert.equal(handover, null);
  const incident = ops.incidents.active().find((i) => i.incident_id === incident_id);
  assert.equal(incident.severity, SEVERITY.EMERGENCY);
  assert.equal(ops.fleet.get("R1").assigned_party, null);
});

test("紧急疏散压过普通推荐，解除后恢复游程", () => {
  const ops = buildOps();
  reserveMainParty(ops);
  registerRobot(ops, "R1");
  ops.dispatch.assignDevice("R1", "party-1");
  ops.dispatch.ingestTelemetry("R1", locationMsg(1, "falls-view"));
  ops.dispatch.updateCrowdLoad("s4", 40); // 先有一次普通拥堵改线

  const incidentId = ops.dispatch.raiseEmergency({
    segment_ids: ["s9"],
    summary: "大瀑布区域紧急疏散",
  });
  let revisions = ops.store.ofAggregate("route_plan", "route-party-1");
  const evacuation = revisions.at(-1);
  assert.equal(evacuation.payload.priority, "emergency");
  assert.equal(evacuation.payload.reason, "emergency_evacuation");
  assert.deepEqual(evacuation.payload.goals, ["gate-main"]); // 最近出口
  assert.deepEqual(evacuation.payload.legs, ["s2", "s1"]);

  // 疏散期间：即便疏散路线本身拥堵，普通推荐也不得顶替疏散方案
  ops.dispatch.updateCrowdLoad("s2", 55);
  assert.equal(ops.store.ofAggregate("route_plan", "route-party-1").length, 3);

  ops.dispatch.clearEmergency(incidentId);
  revisions = ops.store.ofAggregate("route_plan", "route-party-1");
  assert.equal(revisions.at(-1).payload.reason, "emergency_cleared");
  assert.deepEqual(revisions.at(-1).payload.goals, ["rhino-pool", "exit-west"]);
});

test("人工干预留痕并进入调度回放输入", () => {
  const ops = buildOps();
  reserveMainParty(ops);
  ops.dispatch.manualIntervention({ by: "值班员王", action: "note", note: "观景台客流上升，关注" });
  ops.dispatch.manualIntervention({ by: "值班员王", action: "close_segment", segment_id: "s2", note: "扶梯检修" });

  const revisions = ops.store.ofAggregate("route_plan", "route-party-1");
  const latest = revisions.at(-1);
  assert.equal(latest.payload.reason, "manual_override");

  const replay = ops.dispatch.replayDecision(latest.payload.decision_id);
  assert.equal(replay.inputs.manual_interventions.length, 2);
  assert.equal(replay.inputs.manual_interventions[0].action, "note");
  assert.equal(replay.inputs.construction.s2, "manual:值班员王");

  const routeReplay = ops.dispatch.replayRoutePlan("route-party-1");
  assert.equal(routeReplay.events.length, 2);
  assert.equal(routeReplay.decisions.length, 2);
});

test("游客视图：当前路线、设备交接与预计等待变化", () => {
  const ops = buildOps();
  reserveMainParty(ops);
  registerRobot(ops, "R1");
  ops.dispatch.assignDevice("R1", "party-1");
  ops.dispatch.ingestTelemetry("R1", {
    message_id: "b-1",
    device_seq: 1,
    sent_at: "2026-10-04T09:05:00+08:00",
    kind: "battery",
    battery_pct: 80,
  });

  ops.dispatch.updateCrowdLoad("s4", 40); // 改线：31 → 33 分钟
  let view = ops.dispatch.visitorView("party-1");
  assert.equal(view.wait_changes.length, 2);
  assert.equal(view.wait_changes[0].delta_minutes, 0);
  assert.equal(view.wait_changes[1].reason, "congestion");
  assert.equal(view.wait_changes[1].delta_minutes, 2);
  assert.equal(view.current_route.legs[0].from_name, "正门");
  assert.equal(view.device.battery_pct, 80);

  // 客流继续上升但未达改线阈值：实时等待与计划出现偏差
  ops.dispatch.updateCrowdLoad("s2", 30);
  view = ops.dispatch.visitorView("party-1");
  assert.equal(view.current_route.eta_minutes, 33);
  assert.ok(view.live_eta_minutes > 33);
});

test("断网重连后的乱序定位按序驱动队伍位置", () => {
  const ops = buildOps();
  reserveMainParty(ops);
  registerRobot(ops, "R1");
  ops.dispatch.assignDevice("R1", "party-1");

  // 重连后先发来较新的 seq 2（缓存），再补 seq 1（按序应用）
  assert.equal(ops.dispatch.ingestTelemetry("R1", locationMsg(2, "falls-view")).status, "buffered");
  assert.equal(ops.dispatch.visitorView("party-1").current_node, "gate-main");
  assert.equal(ops.dispatch.ingestTelemetry("R1", locationMsg(1, "escalator-top")).status, "applied");
  assert.equal(ops.dispatch.visitorView("party-1").current_node, "falls-view");

  // 重复补发不会把位置拉回旧点
  assert.equal(ops.dispatch.ingestTelemetry("R1", locationMsg(1, "escalator-top")).status, "duplicate");
  assert.equal(ops.dispatch.visitorView("party-1").current_node, "falls-view");
});
