import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { startSources } from '../sources/server.mjs';
import { CountyApp } from '../src/lib/app.mjs';
import { ReferenceData } from '../src/lib/reference-data.mjs';

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
  const workDir = await mkdtemp(join(tmpdir(), 'preschool-collect-'));
  const app = new CountyApp({
    workDir,
    sourceUrl: source.url,
    referencePath: new URL('../data/county-inbox.json', import.meta.url),
    referenceData: reference,
  });
  return app;
}

async function resetStage(stage) {
  const response = await fetch(source.url + '/scenario/' + stage, { method: 'POST' });
  assert.equal(response.status, 204);
}

test('未封账与离线批只登记缺口，绝不猜缺席或零人', async () => {
  await resetStage('initial');
  const app = await newApp();
  await app.importFindings();
  const result = await app.collect();

  const hill = app.assess('hill', '2026-10-17');
  assert.equal(hill.status, 'incomplete');
  assert.deepEqual(hill.missingParts, ['h17b']);

  const river = app.assess('river', '2026-10-17');
  assert.equal(river.status, 'unsealed');
  assert.equal(river.facts.size, 0);

  const gaps = app.gapReport();
  const riverGap = gaps.find(item => item.site === 'river' && item.day === '2026-10-17');
  assert.ok(riverGap.gaps.some(gap => gap.code === 'SEAL_MISSING'));
  const hillGap = gaps.find(item => item.site === 'hill' && item.day === '2026-10-17');
  assert.ok(hillGap.gaps.some(gap => gap.target === 'h17b'));

  // 封账缺批时已到事实只包含已取到的批，未取到的批不产生任何记录
  assert.deepEqual([...hill.facts.keys()].sort(), ['hill/oct/H3', 'hill/oct/H5']);

  // 采集轮询本身不抛错，缺口结构化交接
  assert.ok(result.blocked.some(item => item.site === 'hill' && item.part === 'h17b'));
  assert.ok(result.blocked.some(item => item.site === 'river' && item.reason === 'seal-missing'));
});

test('停课批不计应到，整日标记为 closed', async () => {
  await resetStage('initial');
  const app = await newApp();
  await app.collect();

  const grove = app.assess('grove', '2026-10-17');
  assert.equal(grove.status, 'closed');
  assert.equal(grove.closed, true);
  assert.equal(grove.facts.size, 0);

  const report = app.coverage('2026-10');
  const day = report.days.find(item => item.day === '2026-10-17');
  const groveEntry = day.siteDays.find(item => item.site === 'grove');
  assert.equal(groveEntry.expectedChildren, 0);
  assert.equal(groveEntry.presentChildren, 0);
  assert.equal(report.summary.closedSiteDays, 1);
});

test('离线点重上线后可从缺口接续，缺口被关闭且不丢任何回执', async () => {
  await resetStage('initial');
  const app = await newApp();
  await app.importFindings();
  await app.collect();
  assert.equal(app.assess('hill', '2026-10-17').status, 'incomplete');

  await resetStage('late');
  const backfill = await app.backfill('hill', '2026-10-17');
  assert.deepEqual(backfill.collected.map(item => item.part), ['h17b']);

  const hill = app.assess('hill', '2026-10-17');
  assert.equal(hill.status, 'sealed');
  const presentIds = [...hill.facts.values()].filter(item => item.state === 'present').map(item => item.id);
  assert.deepEqual(presentIds.sort(), ['H5', 'H8']);

  const gaps = app.gapReport().find(item => item.site === 'hill' && item.day === '2026-10-17');
  assert.equal(gaps.gaps.length, 0);
  assert.ok(backfill.gapsClosed.some(item => item.target === 'h17b'));

  // 两条同日回执都在，采集时没有悄悄丢掉
  const batches = app.state.batches.get('h17b');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].batch.records[0].id, 'H8');
});

test('封账代次升高即更正，未齐之前整日为 correction-pending', async () => {
  await resetStage('late');
  const app = await newApp();
  await app.collect();
  assert.equal(app.assess('river', '2026-10-17').status, 'sealed');

  await resetStage('conflict');
  await app.collect({ sites: ['river'], days: ['2026-10-17'] });
  const river = app.assess('river', '2026-10-17');
  assert.equal(river.status, 'correction-pending');
  assert.deepEqual(river.missingParts, ['r17b']);

  // 旧代次批件仍保留，单点事实只采用最新代次；两套原批件都可追溯
  const r17aGenerations = app.state.batches.get('r17a');
  assert.deepEqual(r17aGenerations.map(item => item.generation), [1, 2]);
  assert.equal(r17aGenerations[0].batch.records.length, 2);
  assert.equal(river.seal.generation, 2);
});

test('历史补包遵守当前授权范围，范围外站点被拒绝', async () => {
  await resetStage('initial');
  const app = await newApp();
  await assert.rejects(
    () => app.backfill('unknown-site', '2026-10-17'),
    error => error.code === 'OUT_OF_SCOPE',
  );
});

test('封账记录数与批件不一致时标记 discrepancy', async () => {
  await resetStage('initial');
  const workDir = await mkdtemp(join(tmpdir(), 'preschool-mismatch-'));
  const app = new CountyApp({
    workDir,
    sourceUrl: source.url,
    referencePath: new URL('../data/county-inbox.json', import.meta.url),
    referenceData: reference,
  });
  await app.collect();
  // 手工构造记录数不符场景：重写封账声明为错误计数
  app.store.append('SEAL_FETCHED', {
    site: 'grove',
    day: '2026-10-18',
    seal: {
      site: 'grove',
      day: '2026-10-18',
      generation: 1,
      parts: [{ part: 'g18a', count: 9 }],
    },
  });
  const assessment = app.assess('grove', '2026-10-18');
  assert.equal(assessment.discrepancy, true);
  await rm(workDir, { recursive: true, force: true });
});
