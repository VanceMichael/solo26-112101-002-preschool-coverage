import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startSources } from '../sources/server.mjs';
import { CountyApp } from '../src/lib/app.mjs';
import { EventStore } from '../src/lib/store.mjs';
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

test('事件日志只增，重放后状态与当前投影一致，任何原始回执都保留', async () => {
  const response = await fetch(source.url + '/scenario/late', { method: 'POST' });
  assert.equal(response.status, 204);

  const workDir = await mkdtemp(join(tmpdir(), 'preschool-store-'));
  const app = new CountyApp({
    workDir,
    sourceUrl: source.url,
    referencePath: new URL('../data/county-inbox.json', import.meta.url),
    referenceData: reference,
  });
  await app.importFindings();
  await app.collect();
  const seqBefore = app.state.seq;
  assert.ok(seqBefore > 5);

  // 全新存储实例重放同一日志
  const rebuilt = new EventStore(workDir);
  assert.equal(rebuilt.state.seq, seqBefore);
  assert.equal(rebuilt.state.seals.size, app.state.seals.size);
  assert.equal(rebuilt.state.batches.size, app.state.batches.size);
  assert.equal(rebuilt.state.linkAnnouncements.size, app.state.linkAnnouncements.size);
  assert.equal(rebuilt.state.reviewCases.size, app.state.reviewCases.size);

  // 批件按代次全部保留
  const h17a = rebuilt.state.batches.get('h17a');
  assert.ok(h17a.length >= 1);
  assert.ok(h17a.every(item => item.batch.records));

  // 事件只增：再采集一轮，序号继续增长，历史事件数量不减
  await app.collect();
  const events = app.events();
  assert.equal(events.length, app.state.seq);
  assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1].seq));

  // 快照后再次重放结果一致
  app.snapshot();
  const files = await readdir(workDir);
  assert.ok(files.includes('snapshot.json'));
  assert.ok(files.includes('events.jsonl'));
  const afterSnapshot = new EventStore(workDir);
  assert.equal(afterSnapshot.state.seq, app.state.seq);
  assert.equal(afterSnapshot.state.reviewItems.size, app.state.reviewItems.size);

  await rm(workDir, { recursive: true, force: true });
});
