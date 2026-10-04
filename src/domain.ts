/** 景区伴游任务中枢使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  /** 业务负载：信封字段不变，负载随事件类型扩展。 */
  payload?: Record<string, unknown>;
}

/** 契约约定的事件名称（见 contracts/domain.schema.json）。 */
export type DomainEventType =
  | "VISIT_RESERVED"
  | "DEVICE_ASSIGNED"
  | "ROUTE_REVISED"
  | "CONSENT_CHANGED"
  | "INCIDENT_ESCALATED";

/** 契约约定的聚合类型。 */
export type AggregateType = "visitor_party" | "companion_device" | "route_plan" | "incident";

/** 需要分别取得明示同意的处理范围。 */
export type ConsentScope = "video_recording" | "photo_capture" | "travelogue_generation";
