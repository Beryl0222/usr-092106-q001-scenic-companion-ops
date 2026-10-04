import assert from "node:assert/strict";
import test from "node:test";

import { LiveConditions, RouteError, RouteNetwork, RoutePlanner } from "../src/routing.js";
import { PARK_NETWORK } from "./fixtures.js";

function setup() {
  const network = new RouteNetwork(PARK_NETWORK);
  const conditions = new LiveConditions(network);
  const planner = new RoutePlanner(network, conditions);
  return { network, conditions, planner };
}

test("施工封闭的路段被绕行", () => {
  const { conditions, planner } = setup();
  conditions.close("s2", "construction");
  const plan = planner.plan({ from: "gate-main", to: "falls-view" });
  assert.deepEqual(plan.legs, ["s1", "s7", "s11"]);
});

test("无障碍队伍只走无障碍路段，无法到达即报错", () => {
  const { planner } = setup();
  // 水帘洞两段连接（s3/s6）都不是无障碍路段
  assert.throws(
    () => planner.plan({ from: "falls-view", to: "water-curtain", accessibleOnly: true }),
    RouteError,
  );
  const plan = planner.plan({ from: "falls-view", to: "water-curtain" });
  assert.deepEqual(plan.legs, ["s3"]);
});

test("满载路段硬跳过，改走容量充足的替代路段", () => {
  const { conditions, planner } = setup();
  conditions.setLoad("s4", 50); // 达到容量上限
  const plan = planner.plan({ from: "falls-view", to: "rhino-pool" });
  assert.deepEqual(plan.legs, ["s9", "s10"]);
});

test("拥堵抬高成本，规划自动避开", () => {
  const { conditions, planner } = setup();
  conditions.setLoad("s4", 40); // 拥堵 0.8：成本 26 分钟，高于 s9+s10 的 12 分钟
  const plan = planner.plan({ from: "falls-view", to: "rhino-pool" });
  assert.deepEqual(plan.legs, ["s9", "s10"]);
});

test("改线惩罚阻止重回刚避开的路段", () => {
  const { planner } = setup();
  const plain = planner.plan({ from: "falls-view", to: "rhino-pool" });
  assert.deepEqual(plain.legs, ["s4"]); // 无惩罚时直达更省
  const avoided = planner.plan({
    from: "falls-view",
    to: "rhino-pool",
    avoidPenalties: new Map([["s4", 60]]),
  });
  assert.deepEqual(avoided.legs, ["s9", "s10"]);
});

test("多目标游程依次途经并累计时长", () => {
  const { planner } = setup();
  const journey = planner.planJourney({ from: "gate-main", goals: ["falls-view", "rhino-pool", "exit-west"] });
  assert.deepEqual(journey.legs, ["s1", "s2", "s4", "s5"]);
  assert.equal(journey.eta_minutes, 31);
});
