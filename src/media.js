/**
 * 媒体处理流水线：录像、照片、游记生成各自过授权闸门。
 * 撤回授权后，对应范围的待处理任务立即丢弃（留审计），
 * 后续任何处理尝试都会被授权闸门拦下。
 */
export class MediaPipeline {
  #consent;
  #audit;
  #now;
  #queue = [];
  #completed = [];
  #dropped = [];

  constructor({ consent, audit, now }) {
    this.#consent = consent;
    this.#audit = audit;
    this.#now = now;
    consent.onDecision(({ party_id, scope, decision }) => {
      if (decision === "withdrawn") {
        this.#dropQueued(party_id, scope);
      }
    });
  }

  enqueue(partyId, scope, artifactRef) {
    const job = { party_id: partyId, scope, artifact: artifactRef, enqueued_at: this.#now() };
    this.#queue.push(job);
    return job;
  }

  #dropQueued(partyId, scope) {
    const keep = [];
    for (const job of this.#queue) {
      if (job.party_id === partyId && job.scope === scope) {
        this.#dropped.push(job);
        this.#audit.record({
          kind: "media_job_dropped",
          party_id: partyId,
          scope,
          artifact: job.artifact,
          at: this.#now(),
        });
      } else {
        keep.push(job);
      }
    }
    this.#queue = keep;
  }

  /** 处理全部待办；每个任务都过授权闸门，撤回即抛错停止。 */
  runPending() {
    const results = [];
    for (const job of this.#queue.splice(0)) {
      this.#consent.requireProcessing(job.party_id, job.scope);
      const done = { ...job, processed_at: this.#now() };
      this.#completed.push(done);
      results.push(done);
    }
    return results;
  }

  get queued() {
    return [...this.#queue];
  }

  get completed() {
    return [...this.#completed];
  }

  get dropped() {
    return [...this.#dropped];
  }
}
