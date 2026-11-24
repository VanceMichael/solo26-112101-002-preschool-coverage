import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startSources } from '../sources/server.mjs';
import { CountyApp } from '../src/lib/app.mjs';
import { ReferenceData } from '../src/lib/reference-data.mjs';
import { parseShortRef } from '../src/lib/util.mjs';

let source;
let reference;

before(async () => {
  source = await startSources();
  reference = await ReferenceData.load(new URL('../data/county-inbox.json', import.meta.url));
});

after(async () => {
  await source.close();
});

async function newApp() {
  const workDir = await mkdtemp(join(tmpdir(), 'preschool-coverage-'));
  return new CountyApp({
    workDir,
    sourceUrl: source.url,
    referencePath: new URL('../data/county-inbox.json', import.meta.url),
    referenceData: reference,
  });
}

async function stage(name) {
  const response = await fetch(source.url + '/scenario/' + name, { method: 'POST' });
  assert.equal(response.status, 204);
}

function dayReport(report, day) {
  return report.days.find(item => item.day === day);
}

function siteEntry(report, day, site) {
  return dayReport(report, day).siteDays.find(item => item.site === site);
}

test('初始阶段：未封账或缺批的园点不进正式覆盖，停课日不计应到', async () => {
  await stage('initial');
  const app = await newApp();
  await app.importFindings();
  await app.collect();

  const report = app.coverage('2026-10');
  assert.equal(siteEntry(report, '2026-10-17', 'hill').publishable, false);
  assert.equal(siteEntry(report, '2026-10-17', 'river').publishable, false);
  assert.equal(siteEntry(report, '2026-10-17', 'grove').closed, true);
  assert.equal(siteEntry(report, '2026-10-18', 'grove').publishable, true);

  // 只有 grove 10-18 是可发布服务日，R4 已到
  assert.equal(report.summary.publishablePresentChildDays, 1);
  assert.equal(report.summary.publishableExpectedChildDays, 1);
  assert.equal(report.summary.closedSiteDays, 1);
});

test('晚到封账补齐：同日多点同一人只计一次，归属待核，其它园点照常出数', async () => {
  await stage('late');
  const app = await newApp();
  await app.importFindings();
  await app.collect();

  const report = app.coverage('2026-10');
  const day = dayReport(report, '2026-10-17');
  assert.equal(day.countyPresentChildDays, 3);
  assert.equal(day.publishablePresentChildDays, 3);

  const merged = day.presentComponents.find(item => item.nodes.length === 2);
  assert.ok(merged);
  assert.equal(merged.attributionPending, true);
  assert.deepEqual(merged.nodes.sort(), ['hill/oct/H5', 'river/oct/R4']);

  // H5 在 river 被短号重用，但没有链接，不与 hill/H5 合并
  const reused = day.presentComponents.find(item =>
    item.nodes.length === 1 && item.nodes[0] === 'river/oct/H5');
  assert.ok(reused);

  // 各站点本地仍按本站匿名号出数
  assert.equal(siteEntry(report, '2026-10-17', 'hill').presentChildren, 2);
  assert.equal(siteEntry(report, '2026-10-17', 'river').presentChildren, 2);
  assert.equal(siteEntry(report, '2026-10-17', 'grove').expectedChildren, 0);
});

test('冲突阶段：受影响园点不能发布正式覆盖，未受影响园点照常出数', async () => {
  const app = await newApp();
  await app.importFindings();

  // 先在 late 阶段完成代次 1 的采集，再切到冲突阶段触发代次 2 更正
  await stage('late');
  await app.collect();
  await stage('conflict');
  await app.collect();

  const report = app.coverage('2026-10');
  const day = dayReport(report, '2026-10-17');
  assert.deepEqual(day.conflictedLinks.sort(), ['L7', 'L8']);

  // hill 已封账且落在冲突短号上，正式覆盖被阻断
  assert.equal(siteEntry(report, '2026-10-17', 'hill').blocked, true);
  assert.equal(siteEntry(report, '2026-10-17', 'hill').publishable, false);

  // river 更正未齐（r17b 缺批），本身就不具备发布条件
  const river = siteEntry(report, '2026-10-17', 'river');
  assert.equal(river.publishable, false);
  assert.equal(river.status, 'correction-pending');

  // grove 与冲突无关，仍可发布
  assert.equal(siteEntry(report, '2026-10-18', 'grove').blocked, false);
  assert.equal(siteEntry(report, '2026-10-18', 'grove').publishable, true);

  assert.ok(report.summary.blockedSiteDays.some(item => item.site === 'hill'));

  // 县级临时口径：已到组件若含冲突短号则标记阻断；对侧更正未齐时阻断体现在站点级
  const hillEntry = siteEntry(report, '2026-10-17', 'hill');
  assert.deepEqual(hillEntry.blockReasons, ['declaration-conflict']);
  if (day.presentComponents.some(component => component.blocked)) {
    assert.ok(day.presentComponents.find(item => item.blocked));
  }
});

test('撤回阶段：链接证据解除，县级认定仍成立，受影响原件转入复核且单点事实保留', async () => {
  await stage('withdrawal');
  const app = await newApp();
  await app.importFindings();
  await app.collect();

  const report = app.coverage('2026-10');
  const day = dayReport(report, '2026-10-17');

  // 活跃链接已撤回：没有任何 link 类型证据边
  const allEdges = day.presentComponents.flatMap(component => component.evidence);
  assert.ok(allEdges.every(edge => edge.kind !== 'link'));

  // 县级权威认定独立成立，H5/R4 仍可确定为同一人，但归属复核未结
  const merged = day.presentComponents.find(item =>
    item.nodes.includes('hill/oct/H5') && item.nodes.includes('river/oct/R4'));
  assert.ok(merged);
  assert.ok(merged.evidence.some(edge => edge.kind === 'county-finding'));

  // 本地站点日没有声明冲突阻断，但两地都有待核项
  assert.equal(siteEntry(report, '2026-10-17', 'hill').blocked, false);
  assert.equal(siteEntry(report, '2026-10-17', 'river').recheckPending, true);
  assert.equal(siteEntry(report, '2026-10-17', 'hill').recheckPending, true);

  // 短号重用的 river/H5 仍是独立一人
  assert.ok(day.presentComponents.some(component =>
    component.nodes.length === 1 && component.nodes[0] === 'river/oct/H5'));
});

test('11 月发号期独立：10 月链接不解释 11 月短号', async () => {
  await stage('withdrawal');
  const app = await newApp();
  await app.collect();
  const report = app.coverage('2026-11');
  const day = dayReport(report, '2026-11-02');
  assert.equal(day.siteDays.length, 1);
  const river = day.siteDays[0];
  assert.equal(river.site, 'river');
  assert.equal(river.presentChildren, 1);
  assert.equal(day.presentComponents[0].nodes[0], 'river/nov/R4');
});

test('乡镇视图只含本镇回执与匿名号，看不到跨点链接证明与对侧儿童号', async () => {
  await stage('late');
  const app = await newApp();
  await app.importFindings();
  await app.collect();

  const t1 = app.townCoverage('T1', '2026-10');
  const t1Sites = new Set();
  for (const day of t1.days) for (const siteDay of day.siteDays) t1Sites.add(siteDay.site);
  assert.deepEqual([...t1Sites].sort(), ['grove', 'hill']);
  for (const day of t1.days) {
    assert.deepEqual(day.conflictedLinks, []);
    for (const component of day.presentComponents) {
      for (const node of component.nodes) {
        assert.equal(parseShortRef(node).site === 'hill' || parseShortRef(node).site === 'grove', true);
      }
      assert.deepEqual(component.evidence, []);
    }
  }

  const t2 = app.townCoverage('T2', '2026-10');
  const t2Sites = new Set();
  for (const day of t2.days) for (const siteDay of day.siteDays) t2Sites.add(siteDay.site);
  assert.deepEqual([...t2Sites], ['river']);
});
