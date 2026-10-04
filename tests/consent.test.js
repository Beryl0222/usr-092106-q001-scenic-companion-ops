import assert from "node:assert/strict";
import test from "node:test";

import { AuditLog } from "../src/audit.js";
import { CONSENT_SCOPES, ConsentError, ConsentService } from "../src/consent.js";
import { EventStore } from "../src/event-store.js";
import { MediaPipeline } from "../src/media.js";
import { createIdFactory, createMutableClock } from "../src/util.js";

function setup() {
  const store = new EventStore();
  const ids = createIdFactory("evt");
  const now = createMutableClock("2026-10-04T09:00:00+08:00");
  const audit = new AuditLog();
  const consent = new ConsentService({ store, ids, now, audit });
  const media = new MediaPipeline({ consent, audit, now });
  store.append({
    event_id: ids(),
    event_type: "VISIT_RESERVED",
    aggregate_type: "visitor_party",
    aggregate_id: "party-1",
    occurred_at: now(),
    version: 1,
    summary: "预约伴游",
  });
  return { store, ids, now, audit, consent, media };
}

test("设备默认设置不构成授权：未明示同意前一律拒绝", () => {
  const { consent, audit } = setup();
  assert.equal(consent.allows("party-1", CONSENT_SCOPES.VIDEO_RECORDING), false);
  assert.throws(
    () => consent.requireProcessing("party-1", CONSENT_SCOPES.VIDEO_RECORDING),
    ConsentError,
  );
  const gates = audit.entries({ kind: "processing_gate", party_id: "party-1" });
  assert.equal(gates.at(-1).allowed, false);
});

test("录像、照片、游记生成分别取得明示同意", () => {
  const { consent } = setup();
  consent.grant("party-1", CONSENT_SCOPES.VIDEO_RECORDING);
  assert.equal(consent.allows("party-1", CONSENT_SCOPES.VIDEO_RECORDING), true);
  assert.equal(consent.allows("party-1", CONSENT_SCOPES.PHOTO_CAPTURE), false);
  assert.equal(consent.allows("party-1", CONSENT_SCOPES.TRAVELOGUE_GENERATION), false);
});

test("授权决定写入 CONSENT_CHANGED 事件并沿聚合版本递增", () => {
  const { store, consent } = setup();
  consent.grant("party-1", CONSENT_SCOPES.PHOTO_CAPTURE);
  consent.withdraw("party-1", CONSENT_SCOPES.PHOTO_CAPTURE);
  const events = store.ofAggregate("visitor_party", "party-1");
  assert.deepEqual(
    events.map((event) => [event.event_type, event.version]),
    [
      ["VISIT_RESERVED", 1],
      ["CONSENT_CHANGED", 2],
      ["CONSENT_CHANGED", 3],
    ],
  );
  assert.equal(events[2].payload.decision, "withdrawn");
});

test("撤回授权后停止后续处理，安全审计保留", () => {
  const { consent, media, audit } = setup();
  const scope = CONSENT_SCOPES.TRAVELOGUE_GENERATION;
  consent.grant("party-1", scope);
  media.enqueue("party-1", scope, "clip-001");
  media.enqueue("party-1", scope, "clip-002");
  assert.equal(media.runPending().length, 2);

  media.enqueue("party-1", scope, "clip-003");
  consent.withdraw("party-1", scope, { reason: "游客要求停止生成游记" });

  // 待处理任务被丢弃，后续处理被闸门拦下
  assert.deepEqual(media.dropped.map((job) => job.artifact), ["clip-003"]);
  assert.equal(media.runPending().length, 0);
  assert.throws(() => consent.requireProcessing("party-1", scope), /未授权/);

  // 审计链完整：同意、撤回、丢弃、拦截都留痕
  assert.equal(audit.entries({ kind: "consent_decision", party_id: "party-1" }).length, 2);
  assert.equal(audit.entries({ kind: "media_job_dropped", party_id: "party-1" }).length, 1);
  assert.ok(audit.entries({ kind: "processing_gate", party_id: "party-1" }).some((entry) => entry.allowed === false));
});

test("未登记的同行组不能授权", () => {
  const { consent } = setup();
  assert.throws(() => consent.grant("party-404", CONSENT_SCOPES.PHOTO_CAPTURE), /未登记的同行组/);
});
