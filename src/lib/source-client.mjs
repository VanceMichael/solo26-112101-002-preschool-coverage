// 来源客户端：只按封账清单列出的批号取件，绝不凭站点名或短号猜测缺席与零人。
// 425（未封账）、503（离线）、404（缺路由）都转成结构化缺口，由后续轮询接续。

const REQUEST_TIMEOUT_MS = 5000;

export class SourceClient {
  /**
   * @param {string} baseUrl 来源服务地址
   * @param {{fetch?: typeof fetch}} [deps]
   */
  constructor(baseUrl, deps = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = deps.fetch ?? fetch;
  }

  async _getJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      clearTimeout(timer);
      return { ok: false, status: 'NETWORK', error, path };
    }
    clearTimeout(timer);
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    return { ok: response.ok, status: response.status, data, path };
  }

  /** 点位目录：站点与可采集日期。 */
  async catalog() {
    return this._getJson('/centers');
  }

  /** 封账清单。425 表示来源暂缺封账。 */
  seal(site, day) {
    return this._getJson(`/centers/${site}/${day}/seal`);
  }

  /** 单批回执。 */
  part(site, partId) {
    return this._getJson(`/centers/${site}/part/${partId}`);
  }

  /** 按月链接声明。 */
  links(term) {
    return this._getJson(`/links/${term}`);
  }

  /** 乡镇收件台答复（只返回该镇有权看到的内容）。 */
  townReplies(town) {
    return this._getJson(`/town/${town}/replies`);
  }
}

/**
 * 把来源响应翻译成缺口结构。
 * 封账存在但批件拿不到 -> MISSING_PART；封账缺失 -> SEAL_MISSING。
 */
export function describeGap(kind, target, detail) {
  return { code: kind, target, detail, openedBy: 'collector' };
}
