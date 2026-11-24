#!/usr/bin/env node
// 端到端演练：在临时工作目录中走完 initial -> late -> conflict -> withdrawal，
// 展示缺口交接、同一人去重、冲突阻断、撤回重查、乡镇分视与签收修订的完整流程。
// 用法：node scripts/demo.mjs

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSources } from '../sources/server.mjs';
import { CountyApp } from '../src/lib/app.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const referencePath = join(root, 'data/county-inbox.json');

const line = title => {
  process.stdout.write(`\n${'═'.repeat(72)}\n ${title}\n${'═'.repeat(72)}\n`);
};
const briefGap = report => report.map(item => ({
  site: item.site,
  day: item.day,
  status: item.status,
  missing: item.missingParts,
  gaps: item.gaps.map(gap => `${gap.code}:${gap.target}`),
}));

const source = await startSources(0);
const workDir = await mkdtemp(join(tmpdir(), 'preschool-demo-'));
const app = new CountyApp({ workDir, sourceUrl: source.url, referencePath });
await app.referenceData();

try {
  line('阶段一 initial：封账未齐、点位离线、未封账都只形成有依据的缺口');
  await fetch(source.url + '/scenario/initial', { method: 'POST' });
  await app.importFindings();
  const first = await app.collect();
  console.log('本轮取到批件：', first.collected.map(item => `${item.part}(gen${item.generation})`));
  console.log('结构化缺口：', JSON.stringify(briefGap(app.gapReport()), null, 2));
  console.log('10 月可发布覆盖（停课日不计应到）：');
  console.log(JSON.stringify(app.coverage('2026-10').summary, null, 2));

  line('阶段二 late：离线点上线，补包接续；同日跨点已到按一人计、归属待核');
  await fetch(source.url + '/scenario/late', { method: 'POST' });
  const backfill = await app.backfill('hill', '2026-10-17');
  console.log('hill 补包：', backfill.collected.map(item => item.part), '关闭缺口：', backfill.gapsClosed);
  await app.collect();
  const lateReport = app.coverage('2026-10');
  const day17 = lateReport.days.find(item => item.day === '2026-10-17');
  console.log('10-17 县级已到儿童日（同一人只计一次）：', day17.countyPresentChildDays);
  console.log('跨点组件（归属待核）：', JSON.stringify(
    day17.presentComponents.filter(c => c.attributionPending), null, 2));
  console.log('县级复核台：', JSON.stringify(app.countyReviewBoard().map(c => ({
    case: c.case, version: c.currentVersion, reason: c.reason,
    items: c.items.map(i => ({ site: i.site, status: i.status, own: i.ownRefs.map(r => r.id) })),
  })), null, 2));

  line('乡镇视角隔离：T1 看不到 river/R4，T2 看不到 hill/H5，跨点证明不出县');
  console.log('T1 收件台：', JSON.stringify(app.townReviewQueue('T1'), null, 2));
  console.log('T2 收件台：', JSON.stringify(app.townReviewQueue('T2'), null, 2));

  line('乡镇分开确认与首次签收（T2 先逐项认领，再签收）');
  for (const item of app.townReviewQueue('T2')) {
    app.setReviewItemStatus('T2', item.itemId, 'claimed', '站点核对回执无误');
  }
  const t2Signoff = app.signoffTown('T2', '2026-10');
  console.log('T2 已签收：', t2Signoff.signedAt, '口径指纹', t2Signoff.basisDigest);
  try {
    app.signoffTown('T1', '2026-10');
  } catch (error) {
    console.log('T1 签收被阻断：', error.code, '— 仍有待认领项');
  }

  line('阶段三 conflict：双声明冲突，受影响园点不发布正式覆盖，其它园点照常');
  await fetch(source.url + '/scenario/conflict', { method: 'POST' });
  await app.collect();
  const conflictReport = app.coverage('2026-10');
  console.log('阻断站点：', conflictReport.summary.blockedSiteDays);
  console.log('仍可发布的 grove 10-18：', conflictReport.days
    .find(d => d.day === '2026-10-18').siteDays
    .find(s => s.site === 'grove').publishable);

  line('阶段四 withdrawal：链接撤回，旧答复不结新案，只对受影响原件发重查');
  await fetch(source.url + '/scenario/withdrawal', { method: 'POST' });
  await app.collect();
  const pullT1 = await app.pullTownReplies('T1');
  console.log('T1 来源旧答复导入结果：', pullT1.map(r => ({ state: r.state, accepted: r.accepted, reason: r.reason })));
  const pullT2 = await app.pullTownReplies('T2');
  console.log('T2 来源答复导入结果：', pullT2.map(r => ({ state: r.state, accepted: r.accepted, reason: r.reason })));
  console.log('撤回重查案件：', JSON.stringify(app.countyReviewBoard()
    .filter(c => c.reason === 'link-withdrawn-recheck')
    .map(c => ({ case: c.case, version: c.currentVersion, refs: c.refs })), null, 2));

  line('签收后的修订影响：旧快照不动，受影响站点与日期可查');
  const impact = app.revisionImpact('T2', '2026-10');
  console.log('相对 T2 已签收口径的变化：', JSON.stringify({
    changed: impact.changed,
    basisChanged: impact.basisChanged,
    affected: impact.affectedSiteDays.map(i => `${i.site}@${i.day}`),
  }, null, 2));

  line('11 月独立发号期：10 月链接不解释 11 月短号');
  console.log(JSON.stringify(app.coverage('2026-11').summary, null, 2));

  line('只增审计日志概览');
  const counts = new Map();
  for (const event of app.events()) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  console.log(JSON.stringify(Object.fromEntries(counts), null, 2));
  console.log('工作目录：', workDir);
} finally {
  await source.close();
  await rm(workDir, { recursive: true, force: true });
}
