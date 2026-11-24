// 服务覆盖统计。输入只来自已封账服务日的单点事实和当日适用的身份证据。
// 同日多点已到且可确定同一人 -> 只计一次、归属待核；声明冲突 -> 受影响园点不发布正式覆盖；
// 停课日不计应到；未封账/缺批/更正未齐一律不进正式统计，只进缺口清单。

import { assessDay } from './day-facts.mjs';
import { activeDeclarationsOn, buildIdentityGraph, findConflicts } from './identity.mjs';
import { monthOf, parseShortRef, shortRefKey } from './util.mjs';

function openReviewItemSites(state, day, siteDays) {
  const sites = new Set();
  for (const reviewCase of state.reviewCases.values()) {
    if (reviewCase.day !== day) continue;
    const version = reviewCase.versions.get(reviewCase.currentVersion);
    for (const item of version.items) {
      const current = state.reviewItems.get(item.itemId);
      if (current && current.status !== 'claimed' && current.status !== 'accepted') {
        sites.add(item.site);
      }
    }
  }
  return sites;
}

/**
 * 计算一段站点日的覆盖情况。
 * @param {object} state 投影状态
 * @param {{site: string, day: string}[]} siteDays
 * @param {object} referenceData 县级参考数据
 * @param {string} [period] 只统计该期间（YYYY-MM），缺省按天自带月份
 */
export function buildCoverage(state, siteDays, referenceData, period = null) {
  const days = [];
  const dayIndex = new Map();

  for (const { site, day } of siteDays) {
    if (period && monthOf(day) !== period) continue;
    const assessment = assessDay(state, site, day);
    // 目录里有、但既无封账也无缺口记录的站点日不属于本次采集范围，跳过
    if (!assessment.seal && assessment.gaps.length === 0) continue;
    let entry = dayIndex.get(day);
    if (!entry) {
      entry = {
        day,
        siteDays: [],
        presentComponents: [],
        conflictedLinks: [],
        blockedSites: [],
        recheckSites: [],
        countyPresentChildDays: 0,
        publishablePresentChildDays: 0,
        expectedChildDays: 0,
        publishableExpectedChildDays: 0,
      };
      dayIndex.set(day, entry);
      days.push(entry);
    }

    const siteEntry = {
      site,
      town: referenceData.townOf(site) ?? null,
      status: assessment.status,
      sealed: assessment.status === 'sealed',
      fullyCollected: ['sealed', 'closed'].includes(assessment.status),
      closed: assessment.closed,
      missingParts: assessment.missingParts,
      gapCodes: assessment.gaps.map(gap => gap.code),
      expectedChildren: 0,
      presentChildren: 0,
      presentRefs: [],
      blocked: false,
      blockReasons: [],
      recheckPending: false,
      recheckReasons: [],
      publishable: false,
    };
    entry.siteDays.push(siteEntry);

    if (assessment.status !== 'sealed') continue;

    const facts = [...assessment.facts.values()];
    siteEntry.expectedChildren = facts.length;
    const presentFacts = new Map(
      facts.filter(fact => fact.state === 'present').map(fact => [
        shortRefKey(site, fact.issueTerm, fact.id),
        fact,
      ]),
    );
    siteEntry.presentChildren = presentFacts.size;
    siteEntry.presentRefs = [...presentFacts.keys()];
    entry.expectedChildDays += facts.length;
  }

  // 每日身份图与跨点判定。
  for (const entry of days) {
    const presentFacts = new Map();
    for (const siteEntry of entry.siteDays) {
      if (!['sealed', 'closed'].includes(siteEntry.status)) continue;
      const assessment = assessDay(
        state,
        siteEntry.site,
        entry.day,
      );
      for (const [key, fact] of assessment.facts) {
        if (fact.state === 'present') presentFacts.set(key, fact);
      }
    }

    const findings = referenceData.allFindingsOn(entry.day);
    const graph = buildIdentityGraph(state, entry.day, presentFacts, findings);
    const active = activeDeclarationsOn(state, entry.day);
    const conflicts = findConflicts(active, entry.day);
    entry.conflictedLinks = [...conflicts];

    const openSites = openReviewItemSites(state, entry.day, siteDays);

    // 冲突声明引用到、但对侧因更正未齐而暂无已到事实的站点，同样阻断正式覆盖
    const conflictOnlySites = new Set();
    if (conflicts.size > 0) {
      for (const declaration of active) {
        if (!conflicts.has(declaration.linkId)) continue;
        for (const ref of declaration.refs) {
          if (entry.siteDays.some(siteEntry => siteEntry.site === ref.site)) {
            conflictOnlySites.add(ref.site);
          }
        }
      }
    }

    for (const siteEntry of entry.siteDays) {
      const blockedHere = siteEntry.presentRefs.some(ref => graph.blockedNodes.has(ref))
        || conflictOnlySites.has(siteEntry.site);
      if (blockedHere) {
        siteEntry.blocked = true;
        siteEntry.blockReasons.push('declaration-conflict');
        entry.blockedSites.push(siteEntry.site);
      }
      if (openSites.has(siteEntry.site)) {
        siteEntry.recheckPending = true;
        siteEntry.recheckReasons.push('open-review-item');
        entry.recheckSites.push(siteEntry.site);
      }
      siteEntry.publishable = siteEntry.fullyCollected && !siteEntry.blocked;
    }

    // 县级口径：同一身份组件只计一个已到儿童日。
    const presentComponentDetails = graph.components
      .map(nodes => {
        const presentNodes = nodes.filter(node => presentFacts.has(node));
        return {
          nodes: presentNodes,
          sites: [...new Set(presentNodes.map(node => parseShortRef(node).site))],
          countedOnce: presentNodes.length > 0 ? 1 : 0,
          attributionPending: presentNodes.length > 1,
          blocked: presentNodes.some(node => graph.blockedNodes.has(node)),
          evidence: graph.edges
            .filter(edge => presentNodes.includes(edge.nodes[0]) && presentNodes.includes(edge.nodes[1]))
            .map(edge => (edge.kind === 'link'
              ? { kind: 'link', linkId: edge.linkId, usable: edge.usable }
              : { kind: 'county-finding' })),
        };
      })
      .filter(component => component.nodes.length > 0);

    entry.presentComponents = presentComponentDetails;
    entry.countyPresentChildDays = presentComponentDetails.reduce((sum, item) => sum + item.countedOnce, 0);
    entry.publishablePresentChildDays = presentComponentDetails
      .filter(item => !item.blocked)
      .reduce((sum, item) => sum + item.countedOnce, 0);
    entry.publishableExpectedChildDays = entry.siteDays
      .filter(item => item.fullyCollected && !item.blocked && !item.closed)
      .reduce((sum, item) => sum + item.expectedChildren, 0);
  }

  const summary = summarize(days, referenceData);
  return {
    period,
    generatedAt: new Date().toISOString(),
    days,
    summary,
  };
}

function summarize(days, referenceData) {
  const allSiteDays = days.flatMap(day => day.siteDays);
  const sealedSiteDays = allSiteDays.filter(item => item.fullyCollected);
  const closedSiteDays = sealedSiteDays.filter(item => item.closed).length;
  const blockedSiteDays = allSiteDays.filter(item => item.blocked);
  const recheckSiteDays = allSiteDays.filter(item => item.recheckPending);

  const countyPresent = days.reduce((sum, day) => sum + day.countyPresentChildDays, 0);
  const publishablePresent = days.reduce((sum, day) => sum + day.publishablePresentChildDays, 0);
  const expected = days.reduce((sum, day) => sum + day.expectedChildDays, 0);
  const publishableExpected = days.reduce((sum, day) => sum + day.publishableExpectedChildDays, 0);

  const distinctChildren = new Set();
  const distinctPublishableChildren = new Set();
  for (const day of days) {
    for (const component of day.presentComponents) {
      for (const node of component.nodes) distinctChildren.add(node);
      if (!component.blocked) {
        for (const node of component.nodes) distinctPublishableChildren.add(node);
      }
    }
  }

  return {
    serviceSiteDays: sealedSiteDays.length - closedSiteDays,
    closedSiteDays,
    blockedSiteDays: blockedSiteDays.map(item => ({ site: item.site, town: item.town, reasons: item.blockReasons })),
    recheckSiteDays: recheckSiteDays.map(item => ({ site: item.site, town: item.town, reasons: item.recheckReasons })),
    expectedChildDays: expected,
    presentChildDays: countyPresent,
    publishableExpectedChildDays: publishableExpected,
    publishablePresentChildDays: publishablePresent,
    coverageRate: expected === 0 ? null : Number((countyPresent / expected).toFixed(4)),
    publishableCoverageRate: publishableExpected === 0
      ? null
      : Number((publishablePresent / publishableExpected).toFixed(4)),
    distinctAnonymousChildren: distinctChildren.size,
    publishableDistinctAnonymousChildren: distinctPublishableChildren.size,
    knownTowns: [...new Set(referenceData.scope.map(entry => entry.town))],
  };
}

/**
 * 乡镇视图：只保留本镇站点的回执与匿名汇总；跨点链接证明与对侧儿童号不出县。
 */
export function townView(report, referenceData, town) {
  const allowedSites = new Set(referenceData.sitesOfTown(town));
  const days = report.days.map(day => ({
    day: day.day,
    conflictedLinks: [], // 跨乡镇链接证明留在县内
    blockedSites: day.blockedSites.filter(site => allowedSites.has(site)),
    recheckSites: day.recheckSites.filter(site => allowedSites.has(site)),
    siteDays: day.siteDays
      .filter(siteEntry => allowedSites.has(siteEntry.site))
      .map(siteEntry => ({
        ...siteEntry,
        presentRefs: siteEntry.presentRefs.filter(ref => allowedSites.has(parseShortRef(ref).site)),
      })),
    presentComponents: day.presentComponents.map(component => ({
      ...component,
      nodes: component.nodes.filter(node => allowedSites.has(parseShortRef(node).site)),
      evidence: [],
    })).filter(component => component.nodes.length > 0),
  }));

  return {
    period: report.period,
    town,
    generatedAt: report.generatedAt,
    days,
    summary: {
      serviceSiteDays: days.reduce(
        (sum, day) => sum + day.siteDays.filter(item => item.fullyCollected && !item.closed).length,
        0,
      ),
      closedSiteDays: days.reduce(
        (sum, day) => sum + day.siteDays.filter(item => item.closed).length,
        0,
      ),
      blockedSites: report.summary.blockedSiteDays.filter(item => item.town === town),
      recheckSites: report.summary.recheckSiteDays.filter(item => item.town === town),
    },
  };
}
