// 采集器：按点位目录逐站点、逐日期拉封账与批件。
// 严格遵守乡镇授权范围；离线点重上线时凭站点游标从缺口接续，不重复猜数。

import { assessDay, getSeal } from './day-facts.mjs';
import { describeGap } from './source-client.mjs';

async function fetchJsonOrLog(client, kind, path, store, appendMeta = {}) {
  const result = await client[kind](...path);
  store.append('FETCH_LOGGED', {
    kind,
    path: result.path ?? path.join('/'),
    status: result.status,
    ok: result.ok,
  }, appendMeta);
  return result;
}

/**
 * 全量/增量轮询一次。
 * @returns {{catalog: object, collected: object[], gapsOpened: object[], gapsClosed: object[],
 *   blocked: object[], links: object[]}}
 */
export async function collectOnce({ store, client, referenceData, days = null, sites = null }) {
  const catalogResult = await fetchJsonOrLog(client, 'catalog', [], store);
  if (!catalogResult.ok) {
    const error = new Error(`点位目录不可用：${catalogResult.status}`);
    error.code = 'SOURCE_UNAVAILABLE';
    throw error;
  }
  const catalog = catalogResult.data;
  const targetSites = (sites ?? catalog.sites).filter(site => {
    if (!referenceData.siteTown.has(site)) return false;
    return true;
  });
  const targetDays = days ?? catalog.days;

  const collected = [];
  const gapsOpened = [];
  const gapsClosed = [];
  const blocked = [];

  for (const site of targetSites) {
    referenceData.assertSiteKnown(site);
    for (const day of targetDays) {
      const outcome = await collectSiteDay({ store, client, referenceData, site, day });
      collected.push(...outcome.collected);
      gapsOpened.push(...outcome.gapsOpened);
      gapsClosed.push(...outcome.gapsClosed);
      blocked.push(...outcome.blocked);
      store.append('CURSOR_UPDATED', {
        site,
        cursor: {
          lastAttemptedDay: day,
          lastAttemptAt: new Date().toISOString(),
          status: outcome.status,
        },
      });
    }
  }

  const links = [];
  for (const term of new Set(collected.map(item => item.batch.issueTerm))) {
    links.push(await pullLinks({ store, client, term }));
  }

  return {
    catalog,
    collected,
    gapsOpened,
    gapsClosed,
    blocked,
    links,
  };
}

/**
 * 拉取历史补包：同样遵守当前授权范围，只补指定站点日缺口。
 */
export async function collectBackfill({ store, client, referenceData, site, day }) {
  referenceData.assertSiteKnown(site);
  return collectSiteDay({ store, client, referenceData, site, day });
}

async function collectSiteDay({ store, client, referenceData, site, day }) {
  const collected = [];
  const gapsOpened = [];
  const gapsClosed = [];
  const blocked = [];

  const openGap = gap => {
    store.append('GAP_OPENED', { site, day, gap });
    gapsOpened.push({ site, day, ...gap });
  };
  const closeGap = (code, target) => {
    const existing = (store.state.gaps.get(`${site}@${day}`) ?? [])
      .find(gap => gap.code === code && gap.target === target);
    if (!existing) return;
    store.append('GAP_CLOSED', { site, day, code, target });
    gapsClosed.push({ site, day, code, target });
  };

  const existingSeal = getSeal(store.state, site, day);
  const sealResult = await fetchJsonOrLog(client, 'seal', [site, day], store);

  if (!sealResult.ok) {
    if (sealResult.status === 425) {
      openGap(describeGap('SEAL_MISSING', `${site}/${day}/seal`, sealResult.data?.reason ?? '尚未封账'));
      blocked.push({ site, day, reason: 'seal-missing' });
    } else if (sealResult.status === 404) {
      // 来源明确没有发布该站点日：不是缺口、不猜缺席零人，直接跳过
      return { collected, gapsOpened, gapsClosed, blocked, status: 'not-published' };
    } else {
      openGap(describeGap('SEAL_UNAVAILABLE', `${site}/${day}/seal`, `来源响应 ${sealResult.status}`));
      blocked.push({ site, day, reason: `source-${sealResult.status}` });
    }
    return { collected, gapsOpened, gapsClosed, blocked, status: 'blocked' };
  }

  const seal = sealResult.data;
  if (!existingSeal || existingSeal.generation !== seal.generation) {
    store.append('SEAL_FETCHED', { site, day, seal });
  } else {
    store.append('SEAL_FETCHED', { site, day, seal });
  }

  const assessmentBefore = assessDay(store.state, site, day);
  const beforeMissing = new Set(assessmentBefore.missingParts);

  for (const entry of seal.parts) {
    // 已按当前封账代次取到的批件不再重复拉取，补包只接续真正的缺口
    const already = (store.state.batches.get(entry.part) ?? [])
      .some(item => item.generation === seal.generation);
    if (already) continue;

    const partResult = await fetchJsonOrLog(client, 'part', [site, entry.part], store);
    if (!partResult.ok) {
      const code = partResult.status === 503 ? 'PART_OFFLINE' : 'PART_UNAVAILABLE';
      openGap(describeGap(code, entry.part, partResult.data?.reason ?? `来源响应 ${partResult.status}`));
      blocked.push({ site, day, part: entry.part, reason: code });
      continue;
    }

    const batch = partResult.data;
    if (batch.site !== site || batch.day !== day) {
      openGap(describeGap('BATCH_MISMATCH', entry.part, '批件站点或日期与封账不一致'));
      blocked.push({ site, day, part: entry.part, reason: 'batch-mismatch' });
      continue;
    }
    if (batch.records.length !== entry.count) {
      openGap(describeGap('COUNT_MISMATCH', entry.part,
        `封账记录数 ${entry.count}，批件记录数 ${batch.records.length}`));
    } else {
      const mismatchGap = (store.state.gaps.get(`${site}@${day}`) ?? [])
        .find(gap => gap.code === 'COUNT_MISMATCH' && gap.target === entry.part);
      if (mismatchGap) closeGap('COUNT_MISMATCH', entry.part);
    }

    store.append('BATCH_FETCHED', {
      partId: entry.part,
      generation: seal.generation,
      batch,
    });
    collected.push({ part: entry.part, generation: seal.generation, batch });

    const availabilityGap = (store.state.gaps.get(`${site}@${day}`) ?? [])
      .find(gap => ['PART_OFFLINE', 'PART_UNAVAILABLE'].includes(gap.code) && gap.target === entry.part);
    if (availabilityGap) closeGap(availabilityGap.code, entry.part);
  }

  const sealGap = (store.state.gaps.get(`${site}@${day}`) ?? [])
    .find(gap => gap.code === 'SEAL_MISSING');
  if (sealGap) closeGap('SEAL_MISSING', sealGap.target);

  const assessmentAfter = assessDay(store.state, site, day);
  if (beforeMissing.size && assessmentAfter.missingParts.length === 0) {
    for (const part of beforeMissing) closeGap('PART_OFFLINE', part);
  }

  return {
    collected,
    gapsOpened,
    gapsClosed,
    blocked,
    status: assessmentAfter.status,
  };
}

/** 按月拉取跨点链接声明（整月快照，同 linkId 新公告由投影折叠）。 */
export async function pullLinks({ store, client, term }) {
  const result = await fetchJsonOrLog(client, 'links', [term], store);
  if (!result.ok) {
    return { term, ok: false, status: result.status };
  }
  store.append('LINKS_FETCHED', {
    period: term,
    revision: result.data.revision,
    declarations: result.data.declarations,
  });
  return {
    term,
    ok: true,
    revision: result.data.revision,
    declarations: result.data.declarations,
  };
}
