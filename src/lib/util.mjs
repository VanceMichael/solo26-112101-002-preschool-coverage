// 通用小工具：日期、键、短号标识。全流程只用匿名编号，不接触儿童姓名。

export const dayKey = (site, day) => `${site}@${day}`;

export const monthOf = day => day.slice(0, 7);

export const termMonth = issueTerm => `2026-${issueTerm}`;

/** 短号只在「站点 + 发号期」内有意义，跨点/跨期不得直接比较。 */
export const shortRefKey = (site, issueTerm, id) => `${site}/${issueTerm}/${id}`;

export const parseShortRef = key => {
  const [site, issueTerm, id] = key.split('/');
  return { site, issueTerm, id };
};

export const inDateRange = (day, validFrom, validTo) =>
  day >= validFrom && day <= validTo;

export function assert(condition, message, code = 'INVALID_INPUT') {
  if (!condition) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
}

export function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export const digest = value => {
  const raw = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

export function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}
