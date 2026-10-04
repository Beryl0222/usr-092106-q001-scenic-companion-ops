import { createCompanionOps } from "../src/ops.js";
import { createMutableClock } from "../src/util.js";

/** 黄果树风味的小路网：大门、大瀑布、水帘洞、犀牛潭、天星桥方向的出口与充电点。 */
export const PARK_NETWORK = {
  nodes: [
    { id: "gate-main", name: "正门", kind: "gate" },
    { id: "escalator-top", name: "大扶梯上站", kind: "poi" },
    { id: "falls-view", name: "大瀑布观景台", kind: "poi" },
    { id: "water-curtain", name: "水帘洞", kind: "poi" },
    { id: "rhino-pool", name: "犀牛潭", kind: "poi" },
    { id: "exit-west", name: "西门", kind: "exit" },
    { id: "shelter-plaza", name: "避雨广场", kind: "shelter" },
    { id: "charge-1", name: "1号充电点", kind: "charging" },
  ],
  segments: [
    { id: "s1", from: "gate-main", to: "escalator-top", minutes: 5, accessible: true, capacity: 100 },
    { id: "s2", from: "escalator-top", to: "falls-view", minutes: 10, accessible: true, capacity: 60 },
    { id: "s3", from: "falls-view", to: "water-curtain", minutes: 8, accessible: false, capacity: 30 },
    { id: "s4", from: "falls-view", to: "rhino-pool", minutes: 10, accessible: true, capacity: 50 },
    { id: "s5", from: "rhino-pool", to: "exit-west", minutes: 6, accessible: true, capacity: 80 },
    { id: "s6", from: "water-curtain", to: "rhino-pool", minutes: 7, accessible: false, capacity: 30 },
    { id: "s7", from: "escalator-top", to: "shelter-plaza", minutes: 4, accessible: true, capacity: 200 },
    { id: "s9", from: "falls-view", to: "charge-1", minutes: 6, accessible: true, capacity: 20 },
    { id: "s10", from: "charge-1", to: "rhino-pool", minutes: 6, accessible: true, capacity: 20 },
    { id: "s11", from: "shelter-plaza", to: "falls-view", minutes: 9, accessible: true, capacity: 40 },
  ],
};

export function buildOps(overrides = {}) {
  const now = createMutableClock("2026-10-04T09:00:00+08:00");
  const ops = createCompanionOps({ network: PARK_NETWORK, now, ...overrides });
  return { ...ops, now };
}

/** 轮椅同行组：分时入园 09:30-10:00，目标大瀑布与犀牛潭，讲解内容版本 narr-v3。 */
export function reserveMainParty(ops, partyId = "party-1") {
  return ops.dispatch.reserveVisit({
    party_id: partyId,
    size: 4,
    accessibility_needs: ["wheelchair"],
    entry_slot: { start: "2026-10-04T09:30:00+08:00", end: "2026-10-04T10:00:00+08:00" },
    entry_node: "gate-main",
    exit_node: "exit-west",
    visit_goals: ["falls-view", "rhino-pool"],
    content_version: "narr-v3",
  });
}

export function registerRobot(ops, deviceId, versions = ["narr-v3"]) {
  ops.fleet.register({
    device_id: deviceId,
    kind: "companion_robot",
    capabilities: ["wheelchair"],
    content_versions: versions,
    label: `伴游机器人${deviceId}`,
  });
}

export function registerHumanTeam(ops, deviceId, versions = ["narr-v3"]) {
  ops.fleet.register({
    device_id: deviceId,
    kind: "human_team",
    capabilities: ["wheelchair"],
    content_versions: versions,
    label: `人工讲解队${deviceId}`,
  });
}
