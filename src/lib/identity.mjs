// 匿名身份解析。短号只在「站点 + 发号期」内稳定；跨点是否同一人只能依据：
// 1) 适用于当日且未撤回、未冲突的链接声明；2) 县级权威复核认定。
// 一个月的链接不能解释另一个月的短号；撤回后跨点证据立即失效。

import { inDateRange, shortRefKey } from './util.mjs';

/** 同一 linkId 的较新公告取代此前状态。 */
export function currentDeclarations(state) {
  const result = [];
  for (const announcements of state.linkAnnouncements.values()) {
    const latest = announcements.reduce((a, b) => (a.revision >= b.revision ? a : b));
    result.push(latest);
  }
  return result;
}

/** 适用于指定日期、当前仍活跃的声明。 */
export function activeDeclarationsOn(state, day) {
  return currentDeclarations(state).filter(
    item => item.state === 'active' && inDateRange(day, item.validFrom, item.validTo),
  );
}

export function declarationOnDate(declaration, day) {
  return inDateRange(day, declaration.validFrom, declaration.validTo);
}

/**
 * 冲突：两个活跃声明共享任一短号（同站点同发号期），但连接的完整短号集合不同，
 * 即把同一短号连到了同点同期的不同短号。
 */
export function findConflicts(declarations, day) {
  const active = declarations.filter(item => item.state === 'active' && declarationOnDate(item, day));
  const conflictIds = new Set();
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      if (conflictingPair(active[i], active[j])) {
        conflictIds.add(active[i].linkId);
        conflictIds.add(active[j].linkId);
      }
    }
  }
  return conflictIds;
}

function refKey(ref) {
  return shortRefKey(ref.site, ref.issueTerm, ref.id);
}

function conflictingPair(a, b) {
  const keysA = new Set(a.refs.map(refKey));
  const keysB = new Set(b.refs.map(refKey));
  const shared = [...keysA].filter(key => keysB.has(key));
  if (shared.length === 0) return false;
  // 共享短号但整体连接关系不同 -> 同一短号被指向不同目标
  return keysA.size !== keysB.size || [...keysA].some(key => !keysB.has(key));
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }

  add(node) {
    if (!this.parent.has(node)) this.parent.set(node, node);
  }

  find(node) {
    let root = node;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cursor = node;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor);
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a, b) {
    this.add(a);
    this.add(b);
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }

  components() {
    const map = new Map();
    for (const node of this.parent.keys()) {
      const root = this.find(node);
      if (!map.has(root)) map.set(root, []);
      map.get(root).push(node);
    }
    return [...map.values()];
  }
}

/**
 * 构建某日的身份图。
 * @param {object} state 投影状态
 * @param {string} day
 * @param {Map<string, object>} presentFacts 短号键 -> 当日已到事实（仅已封账服务日）
 * @param {object[]} findings 县级权威认定
 * @returns {{components: string[][], edges: object[], conflictedLinks: Set<string>,
 *   linkedNodes: Set<string>, blockedNodes: Set<string>}}
 */
export function buildIdentityGraph(state, day, presentFacts, findings = []) {
  const declarations = currentDeclarations(state);
  const conflictedLinks = findConflicts(declarations, day);
  const uf = new UnionFind();
  const edges = [];

  for (const node of presentFacts.keys()) uf.add(node);

  for (const declaration of declarations) {
    if (declaration.state !== 'active' || !declarationOnDate(declaration, day)) continue;
    const usable = !conflictedLinks.has(declaration.linkId);
    const presentRefs = declaration.refs
      .map(ref => shortRefKey(ref.site, ref.issueTerm, ref.id))
      .filter(key => presentFacts.has(key));
    if (presentRefs.length < 2) continue;
    for (let i = 1; i < presentRefs.length; i += 1) {
      edges.push({
        kind: 'link',
        linkId: declaration.linkId,
        nodes: [presentRefs[0], presentRefs[i]],
        usable,
      });
      if (usable) uf.union(presentRefs[0], presentRefs[i]);
    }
  }

  // 县级权威认定：认定中的 references 指向两地同日回执，构成独立证据边。
  for (const finding of findings) {
    if (finding.day !== day || finding.result !== 'confirmed-present') continue;
    const anchor = shortRefKey(finding.site, finding.issueTerm, finding.id);
    if (!presentFacts.has(anchor)) continue;
    for (const ref of linkedRefsFromFinding(finding, anchor, presentFacts)) {
      edges.push({ kind: 'county-finding', finding: anchor, nodes: [anchor, ref], usable: true });
      uf.union(anchor, ref);
    }
  }

  const components = uf.components();
  const linkedNodes = new Set();
  for (const edge of edges) {
    if (!edge.usable) continue;
    linkedNodes.add(edge.nodes[0]);
    linkedNodes.add(edge.nodes[1]);
  }
  const blockedNodes = new Set();
  for (const edge of edges) {
    if (edge.kind === 'link' && !edge.usable) {
      blockedNodes.add(edge.nodes[0]);
      blockedNodes.add(edge.nodes[1]);
    }
  }

  return { components, edges, conflictedLinks, linkedNodes, blockedNodes };
}

/**
 * 从县级认定的参考回执里找出对侧站点的已到短号：
 * 只采信 references 中列出的批号，且短号当日确有已到事实。
 */
function linkedRefsFromFinding(finding, anchor, presentFacts) {
  const result = [];
  for (const [key, fact] of presentFacts) {
    if (key === anchor) continue;
    const [site] = key.split('/');
    if (site === finding.site) continue;
    if (!finding.references.includes(fact.part)) continue;
    result.push(key);
  }
  return result;
}

/** 撤回的链接：返回当日曾由它连接、当前仍存在的已到短号对。 */
export function withdrawnImpact(state, day, presentFacts) {
  const impacts = [];
  for (const announcements of state.linkAnnouncements.values()) {
    const latest = announcements.reduce((a, b) => (a.revision >= b.revision ? a : b));
    if (latest.state !== 'withdrawn' || !declarationOnDate(latest, day)) continue;
    const presentRefs = latest.refs
      .map(ref => shortRefKey(ref.site, ref.issueTerm, ref.id))
      .filter(key => presentFacts.has(key));
    if (presentRefs.length >= 2) {
      impacts.push({ linkId: latest.linkId, refs: presentRefs });
    }
  }
  return impacts;
}
