#!/usr/bin/env node
// 县级采集与复核命令行。所有输出为 JSON，便于工作人员交接与脚本串联。
// 工作目录保存只增事件日志；参考数据（乡镇范围与县级认定）由 --reference 指定。

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CountyApp } from './lib/app.mjs';
import { SourceClient } from './lib/source-client.mjs';

const DEFAULTS = {
  workDir: process.env.PRESCHOOL_WORKDIR ?? '.work/county',
  source: process.env.SOURCE_URL ?? 'http://127.0.0.1:4180',
  reference: process.env.REFERENCE_PATH ?? 'data/county-inbox.json',
};

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        index += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { command: positional[0], positional: positional.slice(1), flags };
}

async function createApp(flags) {
  const workDir = resolve(flags.workdir ?? DEFAULTS.workDir);
  mkdirSync(workDir, { recursive: true });
  const app = new CountyApp({
    workDir,
    sourceUrl: flags.source ?? DEFAULTS.source,
    referencePath: resolve(flags.reference ?? DEFAULTS.reference),
  });
  await app.referenceData();
  return app;
}

const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const app = await createApp(flags);

  switch (command) {
    case 'collect': {
      await app.importFindings();
      const result = await app.collect({
        days: flags.day ? [flags.day] : null,
        sites: flags.site ? [flags.site] : null,
      });
      print({
        collected: result.collected.map(item => ({
          part: item.part,
          generation: item.generation,
          records: item.batch.records.length,
        })),
        gapsOpened: result.gapsOpened,
        gapsClosed: result.gapsClosed,
        blocked: result.blocked,
        links: result.links.map(item => ({ term: item.term, ok: item.ok, revision: item.revision ?? null })),
        reconciled: result.reconciled,
      });
      break;
    }

    case 'backfill': {
      const [site, day] = positional;
      if (!site || !day) throw new Error('用法：backfill <site> <day>');
      const result = await app.backfill(site, day);
      print({
        site,
        day,
        status: result.status,
        collected: result.collected.map(item => item.part),
        gapsOpened: result.gapsOpened,
        gapsClosed: result.gapsClosed,
        reconciled: result.reconciled,
      });
      break;
    }

    case 'links': {
      const term = positional[0];
      if (!term) throw new Error('用法：links <term，如 oct>');
      print(await app.refreshLinks(term));
      break;
    }

    case 'gaps': {
      print(app.gapReport());
      break;
    }

    case 'coverage': {
      const period = positional[0] ?? null;
      const town = flags.town ?? null;
      print(town ? app.townCoverage(town, period) : app.coverage(period));
      break;
    }

    case 'review': {
      const sub = positional[0];
      if (sub === 'board') {
        print(app.countyReviewBoard());
      } else if (sub === 'queue') {
        const town = positional[1];
        if (!town) throw new Error('用法：review queue <town>');
        print(app.townReviewQueue(town));
      } else if (sub === 'pull') {
        const town = positional[1];
        if (!town) throw new Error('用法：review pull <town>');
        print(await app.pullTownReplies(town));
      } else if (sub === 'status') {
        const [, town, itemId, status] = positional;
        if (!town || !itemId || !status) {
          throw new Error('用法：review status <town> <itemId> <received|claimed> [--note 说明]');
        }
        print(app.setReviewItemStatus(town, itemId, status, flags.note ?? null));
      } else {
        throw new Error('子命令：board | queue <town> | pull <town> | status <town> <itemId> <status>');
      }
      break;
    }

    case 'signoff': {
      const [scope, period] = positional;
      if (!period) throw new Error('用法：signoff <COUNTY|town> <period，如 2026-10>');
      const snapshot = scope === 'COUNTY'
        ? app.signoffCounty(period, flags.note ?? null)
        : app.signoffTown(scope, period, flags.note ?? null);
      print({
        town: snapshot.town,
        period: snapshot.period,
        signedAt: snapshot.signedAt,
        basisDigest: snapshot.basisDigest,
        blocked: snapshot.blocked,
      });
      break;
    }

    case 'revisions': {
      const [scope, period] = positional;
      if (!period) throw new Error('用法：revisions <COUNTY|town> <period>');
      print(app.revisionImpact(scope, period));
      break;
    }

    case 'signoffs': {
      print(app.listSignoffs().map(item => ({
        town: item.town,
        period: item.period,
        signedAt: item.signedAt,
        basisDigest: item.basisDigest,
      })));
      break;
    }

    case 'snapshot': {
      const seq = app.snapshot();
      print({ snapshotSeq: seq });
      break;
    }

    case 'events': {
      print(app.events().map(event => ({ seq: event.seq, type: event.type, payload: event.payload })));
      break;
    }

    default:
      process.stdout.write([
        '用法：node src/cli.mjs <命令> [参数] [--flag 值]',
        '命令：',
        '  collect [--day YYYY-MM-DD] [--site site]   按封账采集一轮并自动复核立案',
        '  backfill <site> <day>                      历史补包（遵守当前授权范围）',
        '  links <term>                               拉取某月跨点链接声明',
        '  gaps                                       输出有事实依据的补采缺口',
        '  coverage [period] [--town T]               覆盖结果（可按乡镇过滤）',
        '  review board                               县级复核台（含跨点证明，不出县）',
        '  review queue <town>                        乡镇收件台（仅本镇回执与匿名号）',
        '  review pull <town>                         导入乡镇答复',
        '  review status <town> <itemId> <status>     逐项 received/claimed',
        '  signoff <COUNTY|town> <period>             签收冻结当月口径',
        '  revisions <COUNTY|town> <period>           对比签收后的受影响站点与日期',
        '  signoffs                                   已签收清单',
        '  snapshot                                   写投影快照',
        '  events                                     只增事件审计日志',
      ].join('\n') + '\n');
      if (!command) process.exitCode = 1;
  }
}

main().catch(error => {
  process.stderr.write(JSON.stringify({
    error: error.message,
    code: error.code ?? 'ERROR',
    ...(error.openItems ? { openItems: error.openItems } : {}),
  }, null, 2) + '\n');
  process.exitCode = 1;
});
