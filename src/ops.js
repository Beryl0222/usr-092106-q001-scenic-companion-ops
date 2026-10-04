import { AuditLog } from "./audit.js";
import { ConsentService } from "./consent.js";
import { DispatchCenter } from "./dispatcher.js";
import { EventStore } from "./event-store.js";
import { Fleet } from "./fleet.js";
import { IncidentService } from "./incidents.js";
import { MediaPipeline } from "./media.js";
import { LiveConditions, RouteNetwork, RoutePlanner } from "./routing.js";
import { TelemetryIngestor } from "./telemetry.js";
import { createIdFactory } from "./util.js";

/**
 * 组合根：把事件存储、授权、媒体、遥测、车队、路网、告警与调度中枢
 * 装配成一套可运行的伴游任务后端。网络拓扑由调用方按景区实际提供。
 */
export function createCompanionOps({
  network,
  now = () => new Date().toISOString(),
  lowBatteryPct = 20,
  offlineAfterMs = 60_000,
  rerouteCooldownMs = 20 * 60_000,
  congestionThreshold = 0.8,
} = {}) {
  if (!network) {
    throw new Error("createCompanionOps 需要 network（nodes / segments）");
  }
  const store = new EventStore();
  const ids = createIdFactory("evt");
  const audit = new AuditLog();
  const consent = new ConsentService({ store, ids, now, audit });
  const media = new MediaPipeline({ consent, audit, now });
  const telemetry = new TelemetryIngestor({ lowBatteryPct, offlineAfterMs });
  const fleet = new Fleet({ store, ids, now });
  const incidents = new IncidentService({ store, ids, incidentIds: createIdFactory("inc"), now });
  const routeNetwork = new RouteNetwork(network);
  const conditions = new LiveConditions(routeNetwork);
  const planner = new RoutePlanner(routeNetwork, conditions);
  const dispatch = new DispatchCenter({
    store,
    ids,
    decisionIds: createIdFactory("dec"),
    now,
    audit,
    fleet,
    telemetry,
    network: routeNetwork,
    conditions,
    planner,
    incidents,
    rerouteCooldownMs,
    congestionThreshold,
  });
  return { store, audit, consent, media, telemetry, fleet, incidents, network: routeNetwork, conditions, planner, dispatch };
}
