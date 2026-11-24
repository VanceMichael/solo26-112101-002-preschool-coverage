// 县级应用门面：组合事件存储、来源客户端、参考数据与各领域模块，
// 对 CLI 和测试提供稳定用例；所有跨镇证据只在县内方法中出现。

import { collectBackfill, collectOnce, pullLinks } from './collector.mjs';
import { buildCoverage, townView } from './coverage.mjs';
import { assessAllDays, assessDay } from './day-facts.mjs';
import {
  countyReviewBoard,
  importTownReplies,
  openItemsForTown,
  reconcileReviewCases,
  setItemStatus,
  townReviewQueue,
} from './review.mjs';
import { getSignoff, listSignoffs, recordSignoff, revisionImpact } from './signoff.mjs';
import { SourceClient } from './source-client.mjs';
import { EventStore } from './store.mjs';
import { monthOf } from './util.mjs';
import { ReferenceData } from './reference-data.mjs';

export class CountyApp {
  /**
   * @param {{workDir: string, sourceUrl: string, referencePath: string,
   *   client?: SourceClient, referenceData?: ReferenceData}} options
   */
  constructor(options) {
    this.store = new EventStore(options.workDir);
    this.client = options.client ?? new SourceClient(options.sourceUrl);
    this.referencePath = options.referencePath;
    this._referenceData = options.referenceData ?? null;
  }

  async referenceData() {
    if (!this._referenceData) {
      this._referenceData = await ReferenceData.load(this.referencePath);
    }
    return this._referenceData;
  }

  get state() {
    return this.store.state;
  }

  async importFindings() {
    const reference = await this.referenceData();
    if (reference.findings.length === 0) return { imported: 0 };
    this.store.append('FINDINGS_IMPORTED', { findings: reference.findings });
    return { imported: reference.findings.length };
  }

  /** 一次完整采集轮询；之后自动重算复核案件版本。 */
  async collect({ days, sites } = {}) {
    const reference = await this.referenceData();
    const result = await collectOnce({
      store: this.store,
      client: this.client,
      referenceData: reference,
      days,
      sites,
    });
    const reconciled = this.runReconcile();
    return { ...result, reconciled };
  }

  /** 历史补包：遵守当前授权范围，只补指定站点日。 */
  async backfill(site, day) {
    const reference = await this.referenceData();
    const result = await collectBackfill({
      store: this.store,
      client: this.client,
      referenceData: reference,
      site,
      day,
    });
    const reconciled = this.runReconcile(day);
    return { ...result, reconciled };
  }

  async refreshLinks(term) {
    return pullLinks({ store: this.store, client: this.client, term });
  }

  /**
   * 重算复核案件。默认覆盖所有已知站点日；可限定单日。
   * 幂等：案件签名未变时不会产生新版本，旧答复继续有效。
   */
  runReconcile(onlyDay = null) {
    const reference = this._referenceData;
    if (!reference) throw new Error('参考数据尚未载入');
    const siteDays = this.knownSiteDays().filter(item => !onlyDay || item.day === onlyDay);
    const opened = [];
    for (const { day } of siteDays) {
      const sites = [...new Set(siteDays.filter(item => item.day === day).map(item => item.site))];
      opened.push(...reconcileReviewCases(
        this.state,
        day,
        sites,
        reference,
        (type, payload) => this.store.append(type, payload),
      ));
    }
    return opened;
  }

  knownSiteDays() {
    const result = [];
    const seen = new Set();
    for (const key of this.state.seals.keys()) {
      const [site, day] = key.split('@');
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ site, day });
      }
    }
    // 缺口日只在仍有未关闭缺口时纳入；已补齐的站点日由封账键覆盖
    for (const [key, gaps] of this.state.gaps) {
      if (gaps.length === 0 || seen.has(key)) continue;
      const [site, day] = key.split('@');
      seen.add(key);
      result.push({ site, day });
    }
    result.sort((a, b) => (a.day + a.site).localeCompare(b.day + b.site));
    return result;
  }

  /** 缺口交接清单：没有封账、缺批、离线、记录数不符全部可追溯。 */
  gapReport() {
    return assessAllDays(this.state, this.knownSiteDays()).map(item => ({
      site: item.site,
      day: item.day,
      status: item.status,
      sealed: item.seal ? { generation: item.seal.generation, parts: item.seal.parts } : null,
      missingParts: item.missingParts,
      gaps: item.gaps,
      closed: item.closed,
    }));
  }

  assess(site, day) {
    return assessDay(this.state, site, day);
  }

  coverage(period = null) {
    if (!this._referenceData) throw new Error('参考数据尚未载入');
    return buildCoverage(this.state, this.knownSiteDays(), this._referenceData, period);
  }

  townCoverage(town, period = null) {
    if (!this._referenceData) throw new Error('参考数据尚未载入');
    const report = this.coverage(period);
    return townView(report, this._referenceData, town);
  }

  countyReviewBoard() {
    return countyReviewBoard(this.state);
  }

  townReviewQueue(town) {
    return townReviewQueue(this.state, town, this._referenceData);
  }

  /** 拉取并导入某乡镇收件台的答复；跨镇内容来源根本不会出现在该路由。 */
  async pullTownReplies(town) {
    const reference = await this.referenceData();
    if (!reference.townScope.has(town)) {
      const error = new Error(`未知乡镇：${town}`);
      error.code = 'UNKNOWN_TOWN';
      throw error;
    }
    const result = await this.client.townReplies(town);
    if (!result.ok) {
      const error = new Error(`乡镇答复不可用：${result.status}`);
      error.code = 'SOURCE_UNAVAILABLE';
      throw error;
    }
    this.store.append('FETCH_LOGGED', { kind: 'townReplies', town, status: result.status, ok: true });
    return importTownReplies(
      this.state,
      town,
      result.data,
      reference,
      (type, payload) => this.store.append(type, payload),
    );
  }

  setReviewItemStatus(town, itemId, status, note) {
    return setItemStatus(
      this.state,
      itemId,
      status,
      town,
      this._referenceData,
      (type, payload) => this.store.append(type, payload),
      note,
    );
  }

  /**
   * 乡镇签收：仍有未认领的当前版本下发项时拒绝；只冻结本镇可见材料。
   */
  signoffTown(town, period, note = null) {
    const reference = this._referenceData;
    if (!reference.townScope.has(town)) {
      const error = new Error(`未知乡镇：${town}`);
      error.code = 'UNKNOWN_TOWN';
      throw error;
    }
    const open = openItemsForTown(this.state, town, reference, period);
    if (open.length > 0) {
      const error = new Error(`仍有 ${open.length} 项复核未认领，不能签收`);
      error.code = 'REVIEW_OPEN';
      error.openItems = open;
      throw error;
    }
    const report = this.townCoverage(town, period);
    const blocked = report.days
      .flatMap(day => day.siteDays.filter(item => item.blocked || item.recheckPending)
        .map(item => ({ site: item.site, day: day.day, reasons: [...item.blockReasons, ...item.recheckReasons] })));
    return recordSignoff(
      this.state,
      town,
      period,
      report,
      (type, payload) => this.store.append(type, payload),
      { blocked, note },
    );
  }

  /** 县级签收：全县口径冻结；冲突园点只进暂缓清单，不进正式覆盖。 */
  signoffCounty(period, note = null) {
    const report = this.coverage(period);
    const blocked = report.summary.blockedSiteDays;
    return recordSignoff(
      this.state,
      'COUNTY',
      period,
      report,
      (type, payload) => this.store.append(type, payload),
      { blocked, note },
    );
  }

  getSignoff(town, period) {
    return getSignoff(this.state, town, period);
  }

  listSignoffs() {
    return listSignoffs(this.state);
  }

  revisionImpact(town, period) {
    const report = town === 'COUNTY' ? this.coverage(period) : this.townCoverage(town, period);
    return revisionImpact(this.state, town, period, report);
  }

  periods() {
    return [...new Set(this.knownSiteDays().map(item => monthOf(item.day)))].sort();
  }

  snapshot() {
    return this.store.snapshot();
  }

  events() {
    return this.store.readEvents();
  }
}
