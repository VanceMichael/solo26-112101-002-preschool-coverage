import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
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
  const workDir = await mkdtemp(join(tmpdir(), 'preschool-review-'));
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

test('跨点案件按站点拆下发项，乡镇只看到本站短号，看不到对侧儿童号', async () => {
  await stage('late');
  const app = await newApp();
  await app.importFindings();
  await app.collect();

  const board = app.countyReviewBoard();
  const crossCase = board.find(item => item.reason === 'same-day-cross-site-present'
    || item.reason === 'county-confirmed-cross-site');
  assert.ok(crossCase);
  assert.equal(crossCase.items.length, 2);

  const t1Queue = app.townReviewQueue('T1');
  const t1Item = t1Queue.find(item => item.case === crossCase.case);
  assert.ok(t1Item);
  assert.equal(t1Item.site, 'hill');
  assert.deepEqual(t1Item.ownRefs.map(ref => ref.id), ['H5']);
  // 队列载荷中不出现 river 的任何短号
  assert.ok(!JSON.stringify(t1Queue).includes('R4'));

  const t2Queue = app.townReviewQueue('T2');
  const t2Item = t2Queue.find(item => item.case === crossCase.case);
  assert.equal(t2Item.site, 'river');
  assert.deepEqual(t2Item.ownRefs.map(ref => ref.id), ['R4']);
  assert.ok(!JSON.stringify(t2Queue).includes('"H5"'));
});

test('乡镇分开确认：一个站点不能替另一个站点接受，跨镇操作被拒', async () => {
  await stage('late');
  const app = await newApp();
  await app.importFindings();
  await app.collect();

  const t2Item = app.townReviewQueue('T2')[0];
  // T1 无权处理 river 的下发项
  assert.throws(
    () => app.setReviewItemStatus('T1', t2Item.itemId ?? findItemId(app, 'river'), 'claimed'),
    error => error.code === 'OUT_OF_SCOPE',
  );

  // river 自己逐项收件、认领
  const riverItemId = findItemId(app, 'river');
  app.setReviewItemStatus('T2', riverItemId, 'received');
  assert.equal(app.state.reviewItems.get(riverItemId).status, 'received');
  app.setReviewItemStatus('T2', riverItemId, 'claimed');
  assert.equal(app.state.reviewItems.get(riverItemId).status, 'claimed');

  // 已认领不能回退
  assert.throws(
    () => app.setReviewItemStatus('T2', riverItemId, 'received'),
    error => error.code === 'INVALID_TRANSITION',
  );

  // hill 的下发项仍未被 river 带动
  const hillItemId = findItemId(app, 'hill');
  assert.equal(app.state.reviewItems.get(hillItemId).status, 'queued');
});

function findItemId(app, site) {
  const board = app.countyReviewBoard();
  for (const reviewCase of board) {
    const item = reviewCase.items.find(candidate => candidate.site === site);
    if (item) return item.itemId;
  }
  throw new Error(`没有站点 ${site} 的下发项`);
}

test('来源答复只作用于本镇当前版本，旧版本答复不能替新版本结案', async () => {
  const app = await newApp();
  await app.importFindings();

  await stage('late');
  await app.collect();
  let importResult = await app.pullTownReplies('T1');
  assert.equal(importResult[0].accepted, true);
  const hillItemId = findItemId(app, 'hill');
  assert.equal(app.state.reviewItems.get(hillItemId).status, 'claimed');

  // 撤回产生新版本，T1 旧的 v1 claimed 不会让 v2 结案
  await stage('withdrawal');
  await app.collect();
  const board = app.countyReviewBoard();
  const target = board.find(item => item.items.some(entry => entry.site === 'hill'));
  assert.ok(target.currentVersion >= 2);
  const newHillItem = target.items.find(item => item.site === 'hill');
  assert.notEqual(newHillItem.itemId, hillItemId);
  assert.equal(app.state.reviewItems.get(newHillItem.itemId).status, 'queued');

  // 撤回阶段 T1 来源仍是 v1 的 claimed，导入时被判为过期版本
  importResult = await app.pullTownReplies('T1');
  assert.ok(importResult.some(reply => reply.accepted === false && reply.reason === 'superseded-version'));
});

test('四阶段完整演进：跨点 -> 冲突 -> 撤回依次产生新版本，旧版本全部留痕', async () => {
  const app = await newApp();
  await app.importFindings();
  const stages = ['initial', 'late', 'conflict', 'withdrawal'];
  for (const name of stages) {
    await stage(name);
    await app.collect();
  }
  const board = app.countyReviewBoard();
  assert.equal(board.length, 1);
  const reviewCase = board[0];
  assert.equal(reviewCase.case, 'R-HR-17');
  assert.equal(reviewCase.currentVersion, 3);
  assert.deepEqual(reviewCase.history.map(item => item.reason), [
    'same-day-cross-site-present',
    'declaration-conflict',
    'link-withdrawn-recheck',
  ]);

  // 冲突版本即使对侧更正未齐，也带着待补批号（null）下发待核
  const conflictVersion = reviewCase.history.find(item => item.reason === 'declaration-conflict');
  assert.ok(conflictVersion);
  const liveCase = app.state.reviewCases.get('R-HR-17');
  const riverItem = liveCase.versions.get(3).items.find(item => item.site === 'river');
  assert.deepEqual(riverItem.ownRefs.map(ref => ref.id), ['R4']);
});

test('撤回后只对确实受影响的原件发复核，且两侧互不可见对侧号', async () => {
  const app = await newApp();
  await app.importFindings();
  await stage('late');
  await app.collect();
  await stage('withdrawal');
  await app.collect();

  const board = app.countyReviewBoard();
  const withdrawCase = board.find(item => item.reason === 'link-withdrawn-recheck');
  assert.ok(withdrawCase);
  const sites = withdrawCase.items.map(item => item.site).sort();
  assert.deepEqual(sites, ['hill', 'river']);

  // 受影响的只有 L7 连接过的 H5 与 R4，R9 不在撤回链接里
  const refs = withdrawCase.refs.flatMap(ref => ref);
  assert.ok(refs.includes('hill/oct/H5'));
  assert.ok(refs.includes('river/oct/R4'));
  assert.ok(!refs.includes('river/oct/R9'));

  const t2Queue = app.townReviewQueue('T2');
  const t2Withdraw = t2Queue.find(item => item.case === withdrawCase.case);
  assert.deepEqual(t2Withdraw.ownRefs.map(ref => ref.id), ['R4']);
  assert.ok(!JSON.stringify(t2Queue).includes('H5'));
});

test('有未认领下发项时乡镇不能签收，认领后可签收且冻结口径', async () => {
  await stage('late');
  const app = await newApp();
  await app.importFindings();
  await app.collect();

  assert.throws(
    () => app.signoffTown('T2', '2026-10'),
    error => error.code === 'REVIEW_OPEN',
  );

  for (const item of app.townReviewQueue('T2')) {
    app.setReviewItemStatus('T2', item.itemId, 'claimed');
  }
  const snapshot = app.signoffTown('T2', '2026-10');
  assert.equal(snapshot.period, '2026-10');
  assert.ok(snapshot.basisDigest);

  // 签收快照只含 T2 站点
  const sites = new Set();
  for (const day of snapshot.report.days) for (const siteDay of day.siteDays) sites.add(siteDay.site);
  assert.deepEqual([...sites], ['river']);
});

test('已签收月份保留旧口径，晚到材料只形成可查的修订影响', async () => {
  const app = await newApp();
  await app.importFindings();

  await stage('late');
  await app.collect();
  for (const item of app.townReviewQueue('T1')) {
    app.setReviewItemStatus('T1', item.itemId, 'claimed');
  }
  const first = app.signoffTown('T1', '2026-10');
  const firstDigest = first.basisDigest;

  // 撤回带来新复核版本与链接变化
  await stage('withdrawal');
  await app.collect();
  const impact = app.revisionImpact('T1', '2026-10');
  assert.equal(impact.hasPrevious, true);
  assert.equal(impact.changed, true);
  assert.ok(impact.affectedSiteDays.some(item => item.site === 'hill' && item.day === '2026-10-17'));

  // 旧签收快照原封不动
  const stored = app.getSignoff('T1', '2026-10');
  assert.equal(stored.basisDigest, firstDigest);
  assert.equal(stored.signedAt, first.signedAt);

  // 新版本未认领前不能再次签收
  assert.throws(
    () => app.signoffTown('T1', '2026-10'),
    error => error.code === 'REVIEW_OPEN',
  );
});

test('县级可先保留一人覆盖签收，争议站点不能各自签收', async () => {
  await stage('late');
  const app = await newApp();
  await app.importFindings();
  await app.collect();

  // 县级不被乡镇收件状态阻断，记录全县口径与暂缓清单
  const county = app.signoffCounty('2026-10');
  assert.equal(county.town, 'COUNTY');
  assert.ok(Array.isArray(county.report.summary.blockedSiteDays));

  // 两个争议乡镇都还有未认领项，各自签收被拒
  assert.throws(() => app.signoffTown('T1', '2026-10'), error => error.code === 'REVIEW_OPEN');
  assert.throws(() => app.signoffTown('T2', '2026-10'), error => error.code === 'REVIEW_OPEN');
});
