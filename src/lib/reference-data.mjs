// 参考数据：乡镇管辖范围与县级权威复核认定（来自 county-inbox.json）。
// 县内保存跨点事实；下发到乡镇时按 scope 过滤，跨乡镇链接证明不出县。

import { readFile } from 'node:fs/promises';
import { shortRefKey } from './util.mjs';

/**
 * @typedef {Object} ScopeEntry
 * @property {string} town
 * @property {string[]} sites
 *
 * @typedef {Object} ReviewFinding
 * @property {string} site 发起复核的站点
 * @property {string} day
 * @property {string} issueTerm
 * @property {string} id
 * @property {string} result
 * @property {string[]} references
 * @property {string} authority
 */

export class ReferenceData {
  /**
   * @param {{scope: ScopeEntry[], review: ReviewFinding[], requestedPeriods: string[]}} raw
   */
  constructor(raw) {
    this.scope = raw.scope ?? [];
    this.findings = raw.review ?? [];
    this.requestedPeriods = raw.requestedPeriods ?? [];

    /** @type {Map<string, string>} 站点 -> 乡镇 */
    this.siteTown = new Map();
    for (const entry of this.scope) {
      for (const site of entry.sites) this.siteTown.set(site, entry.town);
    }

    /** @type {Map<string, ScopeEntry>} */
    this.townScope = new Map(this.scope.map(entry => [entry.town, entry]));
  }

  static async load(path) {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return new ReferenceData(raw);
  }

  townOf(site) {
    return this.siteTown.get(site);
  }

  sitesOfTown(town) {
    return this.townScope.get(town)?.sites ?? [];
  }

  assertSiteKnown(site) {
    if (!this.siteTown.has(site)) {
      const error = new Error(`站点 ${site} 不在授权范围内`);
      error.code = 'OUT_OF_SCOPE';
      throw error;
    }
  }

  /** 乡镇是否有权处理该站点的材料。 */
  canTownAccessSite(town, site) {
    return this.sitesOfTown(town).includes(site);
  }

  /**
   * 有权人员明确认定的同日跨点事实，按 (站点,日期,短号) 建索引。
   * 这是独立于链接声明的县级证据，撤回链接不撤销已经形成的认定记录。
   */
  findingFor(site, day, issueTerm, id) {
    const key = shortRefKey(site, issueTerm, id);
    return this.findings.find(
      item =>
        shortRefKey(item.site, item.issueTerm, item.id) === key && item.day === day,
    ) ?? null;
  }

  allFindingsOn(day) {
    return this.findings.filter(item => item.day === day);
  }
}
