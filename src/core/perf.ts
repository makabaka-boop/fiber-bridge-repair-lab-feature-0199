/**
 * 上限性能基准：200000 站点 / 400000 链路。
 * 用法：npx tsx src/core/perf.ts（或 node --import tsx）。
 * 断言总耗时 < 5000ms，且整个分析为显式栈迭代、不触发递归深度问题。
 */
import { parseTopology } from './parse';
import { Analyzer } from './analysis';
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

  const ms = (a: number, b: number) => (b - a).toFixed(1);
  console.log(`构造输入: ${ms(t0, t1)} ms`);
  console.log(`解析校验: ${ms(t1, t2)} ms`);
  console.log(`基线Tarjan: ${ms(t2, t3)} ms`);
  console.log(`试接: ${ms(t3, t4)} ms`);
  console.log(`解析+基线+试接合计: ${ms(t1, t4)} ms`);
  console.log(`站点=${analyzer.baseline.siteCount} 链路=${analyzer.baseline.linkCount}`);
  console.log(`基线桥=${analyzer.baseline.bridges.length} 试接后仍脆弱=${trial.stillFragile.length} 已消除=${trial.removed.length}`);

  const budget = 5000;
  if (t4 - t1 > budget) {
    console.error(`超出 ${budget}ms 预算`);
    process.exit(1);
  }
  console.log(`OK：在上限 ${budget}ms 预算内完成`);
}

main();
