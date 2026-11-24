// 只增事件日志 + 内存投影。所有采集、声明、复核、签收动作都先落事件，
// 再折叠成当前状态；重放日志即可完整重建，任何原始回执都不会被悄悄覆盖。

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { shortRefKey } from './util.mjs';

const SNAPSHOT_FILE = 'snapshot.json';

export function createInitialState() {
  return {
    seq: 0,
    /** @type {Map<string, any>} 封账清单，键 site@day */
    seals: new Map(),
    /** @type {Map<string, any[]>} 批件按代次保存，键 partId */
    batches: new Map(),
    /** @type {Map<string, any[]>} 站点日缺口 */
    gaps: new Map(),
    /** @type {Map<string, any>} 链接声明，键 linkId，保留历次公告 */
    linkAnnouncements: new Map(),
    /** 期号 -> 最近一次拉取到的修订号 */
    linkRevisions: new Map(),
    /** 权威复核认定（县级证据） */
    findings: [],
    /** 复核案件 caseId -> { caseId, day, versions: Map(version -> data), currentVersion } */
    reviewCases: new Map(),
    /** 复核项 itemId -> 当前状态 */
    reviewItems: new Map(),
    /** 签收快照，按乡镇/县与期间键控 */
    signoffs: new Map(),
    /** 每个站点的采集游标（用于离线上线后接续缺口） */
    cursors: new Map(),
    /** 来源拉取痕迹 */
    fetchLog: [],
  };
}

export function foldEvent(state, event) {
  const { type, payload } = event;
  switch (type) {
    case 'SEAL_FETCHED': {
      state.seals.set(`${payload.site}@${payload.day}`, payload.seal);
      break;
    }
    case 'BATCH_FETCHED': {
      const list = state.batches.get(payload.partId) ?? [];
      if (!list.some(candidate => candidate.generation === payload.generation)) {
        list.push({
          generation: payload.generation,
          batch: payload.batch,
          fetchedAt: event.at,
          sourceRevision: event.sourceRevision,
        });
        list.sort((a, b) => a.generation - b.generation);
      }
      state.batches.set(payload.partId, list);
      break;
    }
    case 'GAP_OPENED': {
      const key = `${payload.site}@${payload.day}`;
      const list = state.gaps.get(key) ?? [];
      const index = list.findIndex(gap => gap.code === payload.gap.code && gap.target === payload.gap.target);
      if (index === -1) list.push({ ...payload.gap, openedAt: event.at });
      else list[index] = { ...list[index], ...payload.gap, updatedAt: event.at };
      state.gaps.set(key, list);
      break;
    }
    case 'GAP_CLOSED': {
      const key = `${payload.site}@${payload.day}`;
      const list = state.gaps.get(key) ?? [];
      state.gaps.set(
        key,
        list
          .filter(gap => !(gap.code === payload.code && gap.target === payload.target))
          .map(gap => gap),
      );
      break;
    }
    case 'LINKS_FETCHED': {
      for (const declaration of payload.declarations) {
        const list = state.linkAnnouncements.get(declaration.linkId) ?? [];
        if (!list.some(item => item.revision === payload.revision)) {
          list.push({ ...declaration, revision: payload.revision, seenAt: event.at });
          list.sort((a, b) => a.revision - b.revision);
        }
        state.linkAnnouncements.set(declaration.linkId, list);
      }
      state.linkRevisions.set(payload.period, payload.revision);
      break;
    }
    case 'FINDINGS_IMPORTED': {
      for (const finding of payload.findings) {
        const signature = shortRefKey(finding.site, finding.issueTerm, finding.id) + '@' + finding.day;
        if (!state.findings.some(item => item.signature === signature)) {
          state.findings.push({ ...finding, signature, importedAt: event.at });
        }
      }
      break;
    }
    case 'REVIEW_CASE_OPENED': {
      const existing = state.reviewCases.get(payload.caseId);
      if (existing) {
        existing.versions.set(payload.version, payload.versionData);
        existing.currentVersion = Math.max(existing.currentVersion, payload.version);
      } else {
        state.reviewCases.set(payload.caseId, {
          caseId: payload.caseId,
          day: payload.day,
          versions: new Map([[payload.version, payload.versionData]]),
          currentVersion: payload.version,
        });
      }
      for (const item of payload.versionData.items) {
        state.reviewItems.set(item.itemId, { ...item, caseId: payload.caseId, version: payload.version });
      }
      break;
    }
    case 'REVIEW_ITEM_STATUS': {
      const item = state.reviewItems.get(payload.itemId);
      if (item) {
        item.status = payload.status;
        item.updatedAt = event.at;
        if (payload.note) item.note = payload.note;
        if (payload.replySource) item.replySource = payload.replySource;
      }
      break;
    }
    case 'SIGNOFF_RECORDED': {
      state.signoffs.set(`${payload.town}@${payload.period}`, payload);
      break;
    }
    case 'CURSOR_UPDATED': {
      state.cursors.set(payload.site, { ...(state.cursors.get(payload.site) ?? {}), ...payload.cursor });
      break;
    }
    case 'FETCH_LOGGED': {
      state.fetchLog.push({ ...payload, at: event.at });
      break;
    }
    default:
      break;
  }
  state.seq = event.seq;
  return state;
}

export class EventStore {
  constructor(workDir) {
    this.workDir = workDir;
    this.eventPath = join(workDir, 'events.jsonl');
    this.snapshotPath = join(workDir, SNAPSHOT_FILE);
    mkdirSync(workDir, { recursive: true });
    this.state = createInitialState();
    this._replay();
  }

  _replay() {
    if (existsSync(this.snapshotPath)) {
      try {
        const snapshot = JSON.parse(readFileSync(this.snapshotPath, 'utf8'));
        this.state = hydrate(snapshot.state);
        this._lastSnapshotSeq = snapshot.seq;
      } catch {
        this.state = createInitialState();
      }
    }
    if (!existsSync(this.eventPath)) return;
    const lines = readFileSync(this.eventPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const event = JSON.parse(line);
      if (this._lastSnapshotSeq && event.seq <= this._lastSnapshotSeq) continue;
      foldEvent(this.state, event);
    }
  }

  append(type, payload, meta = {}) {
    this.state.seq += 1;
    const event = {
      seq: this.state.seq,
      type,
      payload,
      at: meta.at ?? new Date().toISOString(),
      sourceRevision: meta.sourceRevision,
    };
    appendFileSync(this.eventPath, JSON.stringify(event) + '\n');
    foldEvent(this.state, event);
    return event;
  }

  /** 读取全部原始事件（审计/重放用）。 */
  readEvents() {
    if (!existsSync(this.eventPath)) return [];
    return readFileSync(this.eventPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }

  /** 写快照，事件日志保留；重建时跳过已折叠事件。 */
  snapshot() {
    writeFileSync(
      this.snapshotPath,
      JSON.stringify({ seq: this.state.seq, state: dehydrate(this.state) }),
    );
    return this.state.seq;
  }
}

function dehydrate(state) {
  return {
    ...state,
    seals: [...state.seals.entries()],
    batches: [...state.batches.entries()],
    gaps: [...state.gaps.entries()],
    linkAnnouncements: [...state.linkAnnouncements.entries()],
    linkRevisions: [...state.linkRevisions.entries()],
    reviewCases: [...state.reviewCases.values()].map(item => ({
      ...item,
      versions: [...item.versions.entries()],
    })),
    reviewItems: [...state.reviewItems.entries()],
    signoffs: [...state.signoffs.entries()],
    cursors: [...state.cursors.entries()],
  };
}

function hydrate(raw) {
  const state = createInitialState();
  state.seq = raw.seq;
  for (const [key, value] of raw.seals ?? []) state.seals.set(key, value);
  for (const [key, value] of raw.batches ?? []) state.batches.set(key, value);
  for (const [key, value] of raw.gaps ?? []) state.gaps.set(key, value);
  for (const [key, value] of raw.linkAnnouncements ?? []) state.linkAnnouncements.set(key, value);
  for (const [key, value] of raw.linkRevisions ?? []) state.linkRevisions.set(key, value);
  state.findings = raw.findings ?? [];
  for (const item of raw.reviewCases ?? []) {
    state.reviewCases.set(item.caseId, { ...item, versions: new Map(item.versions) });
  }
  for (const [key, value] of raw.reviewItems ?? []) state.reviewItems.set(key, value);
  for (const [key, value] of raw.signoffs ?? []) state.signoffs.set(key, value);
  for (const [key, value] of raw.cursors ?? []) state.cursors.set(key, value);
  state.fetchLog = raw.fetchLog ?? [];
  return state;
}

/** 测试/演示用：确保工作目录干净。 */
export function ensureEmptyWorkDir(workDir) {
  if (existsSync(workDir)) {
    for (const name of readdirSync(workDir)) {
      throw new Error(`工作目录非空：${join(workDir, name)}`);
    }
  }
  mkdirSync(workDir, { recursive: true });
  return workDir;
}
