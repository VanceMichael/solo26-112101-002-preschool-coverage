import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInitialState, foldEvent } from '../src/lib/store.mjs';
import {
  activeDeclarationsOn,
  buildIdentityGraph,
  findConflicts,
} from '../src/lib/identity.mjs';
import { shortRefKey } from '../src/lib/util.mjs';

function stateWithLinks(declarations, revision = 1) {
  const state = createInitialState();
  for (const declaration of declarations) {
    foldEvent(state, {
      seq: state.seq + 1,
      type: 'LINKS_FETCHED',
      at: new Date().toISOString(),
      payload: { period: 'oct', revision: revision++, declarations: [declaration] },
    });
  }
  return state;
}

const present = (...triples) => new Map(triples.map(([site, term, id]) => {
  const key = shortRefKey(site, term, id);
  return [key, { state: 'present', part: `${site}-${id}`, issueTerm: term, id }];
}));

test('短号只在站点+发号期内有效，跨点重用不合并', () => {
  const state = stateWithLinks([]);
  const facts = present(['hill', 'oct', 'H5'], ['river', 'oct', 'H5']);
  const graph = buildIdentityGraph(state, '2026-10-17', facts, []);
  assert.equal(graph.components.length, 2);
  assert.equal(graph.linkedNodes.size, 0);
});

test('适用于当日的活跃链接把两地已到事实并为同一组件，只计一次', () => {
  const state = stateWithLinks([{
    linkId: 'L7',
    validFrom: '2026-10-16',
    validTo: '2026-10-31',
    state: 'active',
    refs: [
      { site: 'hill', issueTerm: 'oct', id: 'H5' },
      { site: 'river', issueTerm: 'oct', id: 'R4' },
    ],
  }]);
  const facts = present(['hill', 'oct', 'H5'], ['river', 'oct', 'R4']);
  const graph = buildIdentityGraph(state, '2026-10-17', facts, []);
  assert.equal(graph.components.length, 1);
  assert.deepEqual(graph.components[0].sort(), [
    'hill/oct/H5',
    'river/oct/R4',
  ]);
});

test('链接日期区间不覆盖当日时不产生身份边', () => {
  const state = stateWithLinks([{
    linkId: 'L7',
    validFrom: '2026-10-16',
    validTo: '2026-10-31',
    state: 'active',
    refs: [
      { site: 'hill', issueTerm: 'oct', id: 'H5' },
      { site: 'river', issueTerm: 'oct', id: 'R4' },
    ],
  }]);
  const facts = present(['hill', 'oct', 'H5'], ['river', 'oct', 'R4']);
  const graph = buildIdentityGraph(state, '2026-11-02', facts, []);
  assert.equal(graph.components.length, 2);
  assert.equal(activeDeclarationsOn(state, '2026-11-02').length, 0);
});

test('一个月的链接不能解释另一个月的短号', () => {
  const state = stateWithLinks([{
    linkId: 'L7',
    validFrom: '2026-10-16',
    validTo: '2026-10-31',
    state: 'active',
    refs: [
      { site: 'hill', issueTerm: 'oct', id: 'H5' },
      { site: 'river', issueTerm: 'oct', id: 'R4' },
    ],
  }]);
  // 11 月 river 的 R4 与 10 月不是同一发号期，即便短号相同也不连
  const facts = present(['river', 'nov', 'R4'], ['hill', 'oct', 'H5']);
  const graph = buildIdentityGraph(state, '2026-11-02', facts, []);
  assert.equal(graph.components.length, 2);
});

test('同 linkId 较新公告取代旧状态，撤回后跨点边消失', () => {
  const declarations = [
    {
      linkId: 'L7',
      validFrom: '2026-10-16',
      validTo: '2026-10-31',
      state: 'active',
      refs: [
        { site: 'hill', issueTerm: 'oct', id: 'H5' },
        { site: 'river', issueTerm: 'oct', id: 'R4' },
      ],
    },
    {
      linkId: 'L7',
      validFrom: '2026-10-16',
      validTo: '2026-10-31',
      state: 'withdrawn',
      refs: [
        { site: 'hill', issueTerm: 'oct', id: 'H5' },
        { site: 'river', issueTerm: 'oct', id: 'R4' },
      ],
    },
  ];
  const state = stateWithLinks(declarations);
  const facts = present(['hill', 'oct', 'H5'], ['river', 'oct', 'R4']);
  const graph = buildIdentityGraph(state, '2026-10-17', facts, []);
  assert.equal(graph.components.length, 2);
  assert.equal(graph.linkedNodes.size, 0);
  assert.equal(activeDeclarationsOn(state, '2026-10-17').length, 0);
});

test('两个活跃声明把同一短号连到同点同期不同短号时双双冲突待核', () => {
  const declarations = [
    {
      linkId: 'L7',
      validFrom: '2026-10-16',
      validTo: '2026-10-31',
      state: 'active',
      refs: [
        { site: 'hill', issueTerm: 'oct', id: 'H5' },
        { site: 'river', issueTerm: 'oct', id: 'R4' },
      ],
    },
    {
      linkId: 'L8',
      validFrom: '2026-10-16',
      validTo: '2026-10-31',
      state: 'active',
      refs: [
        { site: 'hill', issueTerm: 'oct', id: 'H5' },
        { site: 'river', issueTerm: 'oct', id: 'R9' },
      ],
    },
  ];
  const state = stateWithLinks(declarations);
  const active = activeDeclarationsOn(state, '2026-10-17');
  const conflicts = findConflicts(active, '2026-10-17');
  assert.deepEqual([...conflicts].sort(), ['L7', 'L8']);

  const facts = present(
    ['hill', 'oct', 'H5'],
    ['river', 'oct', 'R4'],
    ['river', 'oct', 'R9'],
  );
  const graph = buildIdentityGraph(state, '2026-10-17', facts, []);
  // 冲突链接不并组件，但相关节点全部标记阻断
  assert.equal(graph.components.length, 3);
  assert.deepEqual([...graph.blockedNodes].sort(), [
    'hill/oct/H5',
    'river/oct/R4',
    'river/oct/R9',
  ]);
});

test('撤回链接后同站点同发号期的单点证据仍然保留可用', () => {
  const declarations = [
    {
      linkId: 'L7',
      validFrom: '2026-10-16',
      validTo: '2026-10-31',
      state: 'withdrawn',
      refs: [
        { site: 'hill', issueTerm: 'oct', id: 'H5' },
        { site: 'river', issueTerm: 'oct', id: 'R4' },
      ],
    },
  ];
  const state = stateWithLinks(declarations);
  const facts = present(['hill', 'oct', 'H5'], ['river', 'oct', 'R4'], ['hill', 'oct', 'H8']);
  const graph = buildIdentityGraph(state, '2026-10-17', facts, []);
  // 跨点边没有了，但三个本站短号事实都在
  assert.equal(graph.components.length, 3);
  assert.equal(graph.blockedNodes.size, 0);
});

test('县级权威认定构成独立证据，即使当日无活跃链接也能并组', () => {
  const state = stateWithLinks([]);
  const facts = present(['hill', 'oct', 'H5'], ['river', 'oct', 'R4']);
  facts.get('river/oct/R4').part = 'r17a';
  facts.get('hill/oct/H5').part = 'h17a';
  const findings = [{
    site: 'river',
    day: '2026-10-17',
    issueTerm: 'oct',
    id: 'R4',
    result: 'confirmed-present',
    references: ['r17a', 'h17a'],
    authority: '县复核员',
  }];
  const graph = buildIdentityGraph(state, '2026-10-17', facts, findings);
  assert.equal(graph.components.length, 1);
  assert.equal(graph.edges[0].kind, 'county-finding');
});
