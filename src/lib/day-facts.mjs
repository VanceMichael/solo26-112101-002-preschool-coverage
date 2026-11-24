// 站点日事实：封账清单与批件的核对结果。
// 规则：没有封账或缺批时，缺席与零人都不能靠猜；停课日不计应到；
// 更正代次更高，未齐之前整日属于待核对；任何原始批件都保留不覆盖。

import { shortRefKey } from './util.mjs';

export function getSeal(state, site, day) {
  return state.seals.get(`${site}@${day}`) ?? null;
}

export function batchGenerations(state, partId) {
  return state.batches.get(partId) ?? [];
}

export function batchAtGeneration(state, partId, generation) {
  return batchGenerations(state, partId).find(item => item.generation === generation) ?? null;
}

export function getGaps(state, site, day) {
  return state.gaps.get(`${site}@${day}`) ?? [];
}

function isClosedBatch(batch) {
  return Array.isArray(batch.records)
    && batch.records.length > 0
    && batch.records.every(record => record.state === 'closed');
}

/**
 * 评估一个站点日的可采信程度。
 * @returns {{status: string, seal: object|null, missingParts: string[], gaps: object[],
 *   closed: boolean, facts: Map<string, {state: string, part: string, issueTerm: string}>,
 *   batches: object[], discrepancy: boolean}}
 */
export function assessDay(state, site, day) {
  const seal = getSeal(state, site, day);
  const gaps = getGaps(state, site, day);
  if (!seal) {
    return {
      status: 'unsealed',
      seal: null,
      missingParts: [],
      gaps,
      closed: false,
      facts: new Map(),
      batches: [],
      discrepancy: false,
    };
  }

  const currentBatches = [];
  const missingParts = [];
  let hasOlderGeneration = false;
  let discrepancy = gaps.some(gap => gap.code === 'COUNT_MISMATCH' || gap.code === 'BATCH_MISMATCH');

  for (const entry of seal.parts) {
    const generations = batchGenerations(state, entry.part);
    if (generations.some(item => item.generation < seal.generation)) {
      hasOlderGeneration = true;
    }
    const current = generations.find(item => item.generation === seal.generation);
    if (!current) {
      missingParts.push(entry.part);
      continue;
    }
    currentBatches.push(current);
    if (current.batch.records.length !== entry.count) {
      discrepancy = true;
    }
  }

  const closed = currentBatches.length > 0
    && missingParts.length === 0
    && currentBatches.every(item => isClosedBatch(item.batch));

  // 单点事实：只采用当前封账代次的批件；停课批没有儿童编号，不产生事实。
  const facts = new Map();
  if (!closed) {
    for (const item of currentBatches) {
      const batch = item.batch;
      for (const record of batch.records) {
        if (record.state === 'closed' || record.id === null) continue;
        const key = shortRefKey(site, batch.issueTerm, record.id);
        facts.set(key, {
          state: record.state,
          part: batch.batch,
          issueTerm: batch.issueTerm,
          id: record.id,
        });
      }
    }
  }

  let status;
  if (missingParts.length > 0) {
    status = hasOlderGeneration ? 'correction-pending' : 'incomplete';
  } else if (discrepancy) {
    status = 'discrepancy';
  } else if (closed) {
    status = 'closed';
  } else {
    status = 'sealed';
  }

  return {
    status,
    seal,
    missingParts,
    gaps,
    closed,
    facts,
    batches: currentBatches,
    discrepancy,
  };
}

/** 已封账的服务日（停课日不是服务日，不计应到）。 */
export function sealedServiceDays(state, siteDays) {
  const result = [];
  for (const { site, day } of siteDays) {
    const assessment = assessDay(state, site, day);
    if (assessment.status === 'sealed') result.push({ site, day, assessment });
  }
  return result;
}

/** 全部已知站点日的评估，供缺口交接使用。 */
export function assessAllDays(state, siteDays) {
  return siteDays.map(({ site, day }) => ({ site, day, ...assessDay(state, site, day) }));
}
