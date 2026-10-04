/** 生成单调递增的记录标识，便于测试与跨聚合追踪。 */
export function createIdFactory(prefix) {
  let seq = 0;
  return () => `${prefix}-${String(++seq).padStart(4, "0")}`;
}

/** 可推进时钟：测试用固定起点，生产传入 () => new Date().toISOString()。 */
export function createMutableClock(startIso) {
  let current = new Date(startIso).getTime();
  const now = () => new Date(current).toISOString();
  now.advance = (ms) => {
    current += ms;
  };
  return now;
}

/** 深冻结：事件与审计记录一旦写入即不可原地改写。 */
export function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}
