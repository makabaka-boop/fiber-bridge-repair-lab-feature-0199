/**
 * 上限性能基准：200000 站点 / 400000 链路 + 100000 组批量筛选。
 * 用法：npx tsx src/core/perf.ts（或 node --import tsx）。
 * 断言总耗时 < 5000ms，且整个分析为显式栈迭代、不触发递归深度问题。
 */
import { parseTopology } from './parse';
import { Analyzer, MAX_BATCH_CANDIDATES } from './analysis';
import type { NormalizedTopology } from './types';

function buildUpperBoundTopology(): string {
  const n = 200_000;
  const sites = new Array<string>(n);
  for (let i = 0; i < n; i++) sites[i] = `site-${i}`;

  // 生成树（长链，制造最深的“递归”场景）n-1 条，再补平行/回边到 400k
  const links: { id: string; u: string; v: string }[] = [];
  for (let i = 1; i < n; i++) {
    links.push({ id: `tree-${i}`, u: sites[i - 1], v: sites[i] });
  }
  let extra = 0;
  while (links.length < 400_000) {
    // 随机回边，跨度足够大时会成大环；也插入部分平行边
    const i = Math.floor(Math.random() * n);
    let j = Math.floor(Math.random() * n);
    if (j === i) j = (j + 1) % n;
    links.push({ id: `x-${extra++}`, u: sites[i], v: sites[j] });
  }
  return JSON.stringify({ sites, links });
}

function normalize(t: NormalizedTopology): NormalizedTopology {
  return t;
}

function main(): void {
  const t0 = performance.now();
  const text = buildUpperBoundTopology();
  const t1 = performance.now();
  const parsed = normalize(parseTopology(text));
  const t2 = performance.now();
  const analyzer = new Analyzer(parsed);
  const t3 = performance.now();
  // 再做一次最坏路径试接（两端在链上相距最远）
  const trial = analyzer.trial(parsed.sites[0], parsed.sites[parsed.sites.length - 1]);
  const t4 = performance.now();

  // 批量方案筛选：100000 组随机端点对（LCA 计数，逐项 O(log V)）
  const n = parsed.sites.length;
  const candidates = new Array<{ a: string; b: string }>(MAX_BATCH_CANDIDATES);
  for (let i = 0; i < candidates.length; i++) {
    const x = Math.floor(Math.random() * n);
    let y = Math.floor(Math.random() * n);
    if (y === x) y = (y + 1) % n;
    candidates[i] = { a: parsed.sites[x], b: parsed.sites[y] };
  }
  const batch = analyzer.batch(JSON.stringify(candidates));
  const t5 = performance.now();

  // 抽查一组：批量计数必须与单次试接明细一致
  const spot = analyzer.trial(candidates[0].a, candidates[0].b);
  if (batch.items[0].removedCount !== spot.removed.length) {
    console.error('批量计数与单次试接不一致');
    process.exit(1);
  }

  const ms = (a: number, b: number) => (b - a).toFixed(1);
  console.log(`构造输入: ${ms(t0, t1)} ms`);
  console.log(`解析校验: ${ms(t1, t2)} ms`);
  console.log(`基线Tarjan+LCA索引: ${ms(t2, t3)} ms`);
  console.log(`试接: ${ms(t3, t4)} ms`);
  console.log(`批量筛选(${candidates.length}组): ${ms(t4, t5)} ms`);
  console.log(`解析+基线+试接+批量合计: ${ms(t1, t5)} ms`);
  console.log(`站点=${analyzer.baseline.siteCount} 链路=${analyzer.baseline.linkCount}`);
  console.log(`基线桥=${analyzer.baseline.bridges.length} 试接后仍脆弱=${trial.stillFragile.length} 已消除=${trial.removed.length}`);
  console.log(`批量首项可消除=${batch.items[0].removedCount}（与单次试接一致）`);

  const budget = 5000;
  if (t5 - t1 > budget) {
    console.error(`超出 ${budget}ms 预算`);
    process.exit(1);
  }
  console.log(`OK：在上限 ${budget}ms 预算内完成`);
}

main();
