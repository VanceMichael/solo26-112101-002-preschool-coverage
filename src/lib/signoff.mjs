// 月份签收。已签收月份保留当时统计口径（快照不可变）；晚到的封账、撤回或核实
// 只改变后续可签收的修订，并给出受影响站点/日期差异，供交接说明。

import { digest, stableStringify } from './util.mjs';

const signoffKey = (town, period) => `${town}@${period}`;

/**
 * 记录一次签收。
 * @param {object} state
 * @param {string} town 'COUNTY' 表示县级，其它为乡镇
 * @param {string} period YYYY-MM
 * @param {object} report 当期覆盖报告（冻结进快照）
 * @param {Function} append 事件追加函数
 * @param {object} [extra]
 */
export function recordSignoff(state, town, period, report, append, extra = {}) {
  const snapshot = {
    town,
    period,
    signedAt: new Date().toISOString(),
    basisDigest: digest(stableStringify(pruneForDigest(report))),
    report,
    blocked: extra.blocked ?? [],
    note: extra.note ?? null,
  };
  append('SIGNOFF_RECORDED', { ...snapshot });
  return snapshot;
}

function pruneForDigest(report) {
  // generatedAt 不参与口径指纹
  const { generatedAt, ...rest } = report;
  return rest;
}

export function getSignoff(state, town, period) {
  return state.signoffs.get(signoffKey(town, period)) ?? null;
}

export function listSignoffs(state) {
  return [...state.signoffs.values()].sort((a, b) =>
    (a.period + a.town).localeCompare(b.period + b.town));
}

/**
 * 把当前报告与最近一次签收快照对比，输出受影响的站点与日期。
 */
export function revisionImpact(state, town, period, currentReport) {
  const previous = getSignoff(state, town, period);
  if (!previous) {
    return {
      period,
      town,
      hasPrevious: false,
      changed: false,
      affectedSiteDays: collectSiteDays(currentReport),
      basisChanged: true,
    };
  }

  const oldSiteDays = new Map(collectSiteDays(previous.report).map(item => [keyOf(item), item]));
  const newSiteDays = new Map(collectSiteDays(currentReport).map(item => [keyOf(item), item]));
  const affected = [];

  for (const [key, current] of newSiteDays) {
    const before = oldSiteDays.get(key);
    if (!before || stableStringify(before) !== stableStringify(current)) {
      affected.push({ site: current.site, day: current.day, before: before ?? null, current });
    }
  }
  for (const [key, before] of oldSiteDays) {
    if (!newSiteDays.has(key)) {
      affected.push({ site: before.site, day: before.day, before, current: null });
    }
  }

  return {
    period,
    town,
    hasPrevious: true,
    previousSignedAt: previous.signedAt,
    changed: affected.length > 0,
    basisChanged: previous.basisDigest !== digest(stableStringify(pruneForDigest(currentReport))),
    affectedSiteDays: affected,
  };
}

function collectSiteDays(report) {
  const result = [];
  for (const day of report.days ?? []) {
    for (const siteDay of day.siteDays ?? []) {
      result.push({
        site: siteDay.site,
        day: day.day,
        status: siteDay.status,
        sealed: siteDay.sealed,
        closed: siteDay.closed,
        blocked: siteDay.blocked,
        blockReasons: siteDay.blockReasons,
        recheckPending: siteDay.recheckPending,
        publishable: siteDay.publishable,
        expectedChildren: siteDay.expectedChildren,
        presentChildren: siteDay.presentChildren,
      });
    }
  }
  return result;
}

const keyOf = item => `${item.site}@${item.day}`;
