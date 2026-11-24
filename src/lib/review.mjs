// 复核案件管理。案件按 case + version 区分；每个版本拆成按站点的下发项，
// 站点只看到自己的短号与回执批号，看不到对侧儿童号，也不能替另一个站点接受。
// 撤回链接时，只对确实受影响的原件发新版本，旧答复不能替新版本结案。

import { assessDay } from './day-facts.mjs';
import {
  activeDeclarationsOn,
  currentDeclarations,
  findConflicts,
  withdrawnImpact,
} from './identity.mjs';
import { digest, parseShortRef, shortRefKey } from './util.mjs';

function caseIdFor(sites, day) {
  const initials = [...new Set(sites)].map(site => site[0].toUpperCase()).join('');
  return `R-${initials}-${day.slice(8)}`;
}

function sealedPresentFacts(state, day, sites) {
  const facts = new Map();
  for (const site of sites) {
    const assessment = assessDay(state, site, day);
    if (assessment.status !== 'sealed') continue;
    for (const [key, fact] of assessment.facts) {
      if (fact.state === 'present') facts.set(key, fact);
    }
  }
  return facts;
}

function itemId(caseId, version, site) {
  return `${caseId}/v${version}/${site}`;
}

function buildItems(caseId, version, refs, reason, referenceData) {
  const sites = [...new Set(refs.map(ref => parseShortRef(ref).site))].sort();
  return sites.map(site => ({
    itemId: itemId(caseId, version, site),
    site,
    town: referenceData.townOf(site) ?? null,
    reason,
    // 只下发本站点自己的短号与批号
    ownRefs: refs
      .filter(ref => parseShortRef(ref).site === site)
      .map(ref => {
        const { id, issueTerm } = parseShortRef(ref);
        return { id, issueTerm, part: null };
      }),
    status: 'queued',
  }));
}

function enrichItemParts(items, presentFacts) {
  for (const item of items) {
    for (const ref of item.ownRefs) {
      const key = shortRefKey(item.site, ref.issueTerm, ref.id);
      ref.part = presentFacts.get(key)?.part ?? null;
    }
  }
  return items;
}

/**
 * 根据当前投影状态，为某一天生成应存在的案件版本。
 * 同一对站点同一天的跨点事实只有一个 caseId：链接、县级认定、撤回等证据合并，
 * 原因按优先级取主因，全部原因保留在 reasons 中。
 * 幂等：签名未变则不开新版本。
 */
export function deriveCasesForDay(state, day, allSites, referenceData) {
  const presentFacts = sealedPresentFacts(state, day, allSites);
  const active = activeDeclarationsOn(state, day);
  const conflictIds = findConflicts(active, day);
  /** @type {Map<string, {caseId: string, day: string, refs: Set<string>,
   * reasons: Set<string>, linkIds: Set<string>, signatures: string[]}>} */
  const buckets = new Map();

  const bucketFor = refs => {
    const sites = [...new Set(refs.map(ref => parseShortRef(ref).site))].sort();
    const caseId = caseIdFor(sites, day);
    if (!buckets.has(caseId)) {
      buckets.set(caseId, {
        caseId,
        day,
        refs: new Set(),
        reasons: new Set(),
        linkIds: new Set(),
        signatures: [],
      });
    }
    return buckets.get(caseId);
  };

  // 1) 链接驱动的同日多点已到（含冲突与正常链接）
  for (const declaration of currentDeclarations(state)) {
    if (declaration.state !== 'active') continue;
    if (declaration.validFrom > day || declaration.validTo < day) continue;
    const allRefs = declaration.refs.map(ref => shortRefKey(ref.site, ref.issueTerm, ref.id));
    const presentRefs = allRefs.filter(key => presentFacts.has(key));
    const conflicted = conflictIds.has(declaration.linkId);
    // 正常链接需要双侧当日已到；冲突本身即待核事实，即使对侧更正未齐也要立案
    if (!conflicted && presentRefs.length < 2) continue;
    if (conflicted && presentRefs.length < 1) continue;
    const refs = conflicted ? allRefs : presentRefs;
    const reason = conflicted ? 'declaration-conflict' : 'same-day-cross-site-present';
    const bucket = bucketFor(refs);
    refs.forEach(ref => bucket.refs.add(ref));
    bucket.reasons.add(reason);
    bucket.linkIds.add(declaration.linkId);
    bucket.signatures.push(digest(
      [...refs].sort().join('|') + '|' + declaration.linkId + '|' + reason,
    ));
  }

  // 2) 县级权威认定（独立证据；即使链接全部撤回仍成立）
  for (const finding of referenceData.allFindingsOn(day)) {
    const anchor = shortRefKey(finding.site, finding.issueTerm, finding.id);
    if (!presentFacts.has(anchor)) continue;
    const refs = [anchor];
    for (const [key, fact] of presentFacts) {
      if (key === anchor || parseShortRef(key).site === finding.site) continue;
      if (finding.references.includes(fact.part)) refs.push(key);
    }
    if (refs.length < 2) continue;
    const bucket = bucketFor(refs);
    refs.forEach(ref => bucket.refs.add(ref));
    bucket.reasons.add('county-confirmed-cross-site');
    bucket.signatures.push(digest('finding|' + [...refs].sort().join('|')));
  }

  // 3) 撤回链接：仅对当日仍有原件回执的受影响短号重新查清
  for (const impact of withdrawnImpact(state, day, presentFacts)) {
    const refs = impact.refs;
    const bucket = bucketFor(refs);
    refs.forEach(ref => bucket.refs.add(ref));
    bucket.reasons.add('link-withdrawn-recheck');
    bucket.linkIds.add(impact.linkId);
    bucket.signatures.push(digest(`withdraw|${impact.linkId}|${[...refs].sort().join('|')}`));
  }

  // 主因优先级：撤回重查 > 声明冲突 > 普通跨点已到 > 县级认定
  const priority = [
    'link-withdrawn-recheck',
    'declaration-conflict',
    'same-day-cross-site-present',
    'county-confirmed-cross-site',
  ];
  const cases = [];
  for (const bucket of buckets.values()) {
    const refs = [...bucket.refs].sort();
    const reasons = [...bucket.reasons];
    const reason = priority.find(candidate => reasons.includes(candidate)) ?? reasons[0];
    const items = enrichItemParts(
      buildItems(bucket.caseId, 0, refs, reason, referenceData),
      presentFacts,
    );
    cases.push({
      caseId: bucket.caseId,
      day,
      reason,
      reasons,
      signature: digest(bucket.signatures.slice().sort().join('||')),
      refs,
      items,
      linkIds: [...bucket.linkIds],
    });
  }
  return cases;
}

/**
 * 把推导结果落到事件：同 caseId 下签名变化才开新版本。
 * @returns {Array} 本次新写入的版本事件载荷
 */
export function reconcileReviewCases(state, day, allSites, referenceData, append) {
  const derived = deriveCasesForDay(state, day, allSites, referenceData);
  const opened = [];
  for (const desired of derived) {
    const existing = state.reviewCases.get(desired.caseId);
    const currentSignature = existing
      ? existing.versions.get(existing.currentVersion)?.signature
      : null;
    if (currentSignature === desired.signature) continue;
    const version = existing ? existing.currentVersion + 1 : 1;
    const versionData = {
      reason: desired.reason,
      reasons: desired.reasons,
      signature: desired.signature,
      refs: desired.refs,
      linkIds: desired.linkIds,
      openedAt: new Date().toISOString(),
      items: desired.items.map(item => ({ ...item, itemId: itemId(desired.caseId, version, item.site) })),
    };
    append('REVIEW_CASE_OPENED', {
      caseId: desired.caseId,
      day: desired.day,
      version,
      versionData,
    });
    opened.push({ caseId: desired.caseId, version });
  }
  return opened;
}

/**
 * 导入乡镇收件台答复。答复只能作用于本镇站点、当前版本的下发项；
 * 旧版本答复不会关闭新版本，跨镇答复直接拒绝。
 */
export function importTownReplies(state, town, replies, referenceData, append) {
  const results = [];
  for (const reply of replies) {
    const reviewCase = state.reviewCases.get(reply.case);
    if (!reviewCase) {
      results.push({ ...reply, accepted: false, reason: 'unknown-case' });
      continue;
    }
    const version = reply.version ?? reviewCase.currentVersion;
    const versionData = reviewCase.versions.get(version);
    if (!versionData) {
      results.push({ ...reply, accepted: false, reason: 'unknown-version' });
      continue;
    }
    const item = versionData.items.find(candidate => candidate.site === reply.site);
    if (!item) {
      results.push({ ...reply, accepted: false, reason: 'site-not-in-case' });
      continue;
    }
    if (!referenceData.canTownAccessSite(town, reply.site)) {
      results.push({ ...reply, accepted: false, reason: 'out-of-town-scope' });
      continue;
    }
    if (reply.part && !item.ownRefs.some(ref => ref.part === reply.part)) {
      results.push({ ...reply, accepted: false, reason: 'part-not-owned-by-site' });
      continue;
    }
    if (version !== reviewCase.currentVersion) {
      results.push({ ...reply, accepted: false, reason: 'superseded-version' });
      continue;
    }
    const allowed = ['received', 'claimed'];
    if (!allowed.includes(reply.state)) {
      results.push({ ...reply, accepted: false, reason: 'unsupported-state' });
      continue;
    }
    const current = state.reviewItems.get(item.itemId);
    if (current && current.status === 'claimed' && reply.state === 'received') {
      results.push({ ...reply, accepted: false, reason: 'cannot-downgrade' });
      continue;
    }
    append('REVIEW_ITEM_STATUS', {
      itemId: item.itemId,
      status: reply.state,
      replySource: `town/${town}`,
      note: reply.note,
    });
    results.push({ ...reply, accepted: true, itemId: item.itemId });
  }
  return results;
}

/** 站点自己逐项操作；不能替另一个站点接受。 */
export function setItemStatus(state, itemId, status, town, referenceData, append, note) {
  const item = state.reviewItems.get(itemId);
  if (!item) {
    const error = new Error(`复核项不存在：${itemId}`);
    error.code = 'UNKNOWN_REVIEW_ITEM';
    throw error;
  }
  if (!referenceData.canTownAccessSite(town, item.site)) {
    const error = new Error('该镇无权处理此复核项');
    error.code = 'OUT_OF_SCOPE';
    throw error;
  }
  if (!['received', 'claimed'].includes(status)) {
    const error = new Error(`不支持的复核状态：${status}`);
    error.code = 'INVALID_INPUT';
    throw error;
  }
  if (item.status === 'claimed' && status === 'received') {
    const error = new Error('已认领的复核项不能回退到仅收件');
    error.code = 'INVALID_TRANSITION';
    throw error;
  }
  append('REVIEW_ITEM_STATUS', { itemId, status, note, replySource: `town/${town}` });
  return state.reviewItems.get(itemId);
}

/**
 * 乡镇收件台视图：只含本镇站点的下发项，剥除跨点证明和对侧儿童号。
 */
export function townReviewQueue(state, town, referenceData) {
  const allowedSites = new Set(referenceData.sitesOfTown(town));
  const queues = [];
  for (const reviewCase of state.reviewCases.values()) {
    const versionData = reviewCase.versions.get(reviewCase.currentVersion);
    for (const item of versionData.items) {
      if (!allowedSites.has(item.site)) continue;
      const current = state.reviewItems.get(item.itemId) ?? item;
      queues.push({
        itemId: item.itemId,
        case: reviewCase.caseId,
        version: reviewCase.currentVersion,
        day: reviewCase.day,
        site: item.site,
        reason: item.reason,
        ownRefs: item.ownRefs,
        status: current.status,
        updatedAt: current.updatedAt ?? null,
      });
    }
  }
  return queues;
}

/** 县级视图：保留完整链接证明，供县内核查，不下发乡镇。 */
export function countyReviewBoard(state) {
  const board = [];
  for (const reviewCase of state.reviewCases.values()) {
    const versionData = reviewCase.versions.get(reviewCase.currentVersion);
    board.push({
      case: reviewCase.caseId,
      day: reviewCase.day,
      currentVersion: reviewCase.currentVersion,
      reason: versionData.reason,
      reasons: versionData.reasons ?? [versionData.reason],
      linkIds: versionData.linkIds,
      refs: versionData.refs,
      items: versionData.items.map(item => ({
        ...item,
        status: state.reviewItems.get(item.itemId)?.status ?? item.status,
      })),
      history: [...reviewCase.versions.entries()].map(([version, data]) => ({
        version,
        reason: data.reason,
        signature: data.signature,
        openedAt: data.openedAt,
      })),
    });
  }
  return board;
}

/** 某乡镇在指定期间是否还有未认领的当前版本下发项（签收阻断条件）。 */
export function openItemsForTown(state, town, referenceData, periodPrefix = null) {
  const queue = townReviewQueue(state, town, referenceData);
  return queue.filter(item => {
    if (periodPrefix && !item.day.startsWith(periodPrefix)) return false;
    return item.status !== 'claimed';
  });
}
