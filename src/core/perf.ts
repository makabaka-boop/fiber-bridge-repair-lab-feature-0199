/**
 * 上限性能基准：200000 站点 / 400000 链路。
 * 用法：npx tsx src/core/perf.ts（或 node --import tsx）。
 * 断言总耗时 < 5000ms，且整个分析为显式栈迭代、不触发递归深度问题。
 *
 * 第二段：200000 站点纯长链 + 100000 组批量方案查询，断言分析器构建
 * （含只读 LCA 索引）与整批查询合计 < 5000ms，且每项计数等于站点距离。
 */
import { parseTopology } from './parse';
import { Analyzer } from './analysis';
import type { BatchPair, NormalizedTopology } from './types';

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

const ms = (a: number, b: number) => (b - a).toFixed(1);

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

  console.log(`构造输入: ${ms(t0, t1)} ms`);
  console.log(`解析校验: ${ms(t1, t2)} ms`);
  console.log(`基线Tarjan(含LCA索引): ${ms(t2, t3)} ms`);
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

  benchBatch();
}

/** 批量方案筛选基准：200000 站点纯长链 + 100000 组查询，计数应等于距离 */
function benchBatch(): void {
  const n = 200_000;
  const q = 100_000;
  const sites = new Array<string>(n);
  for (let i = 0; i < n; i++) sites[i] = `site-${i}`;
  const links: { id: string; u: string; v: string }[] = [];
  for (let i = 1; i < n; i++) {
    links.push({ id: `c-${i}`, u: sites[i - 1], v: sites[i] });
  }

  const b0 = performance.now();
  const chainAnalyzer = new Analyzer(normalize(parseTopology(JSON.stringify({ sites, links }))));
  const b1 = performance.now();

  // 确定性伪随机端点对（线性同余），避免测试间抖动
  let state = 0x9e3779b9;
  const rand = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  const pairs: BatchPair[] = new Array(q);
  for (let i = 0; i < q; i++) {
    const a = Math.floor(rand() * n);
    let b = Math.floor(rand() * n);
    if (b === a) b = (b + 1) % n;
    pairs[i] = { a: sites[a], b: sites[b] };
  }

  const b2 = performance.now();
  const result = chainAnalyzer.screenBatch(pairs);
  const b3 = performance.now();

  // 长链上每条边都是桥：可消除数量必须等于两端点的站点距离
  const indexOf = new Map<string, number>();
  for (let i = 0; i < n; i++) indexOf.set(sites[i], i);
  for (let i = 0; i < q; i++) {
    const it = result.items[i];
    const dist = Math.abs(indexOf.get(it.a)! - indexOf.get(it.b)!);
    if (it.removedCount !== dist || it.index !== i) {
      console.error(`下标 ${i} 计数错误：期望距离 ${dist}，实际 ${it.removedCount}`);
      process.exit(1);
    }
  }

  console.log(`—— 批量方案筛选（200000 站点长链 / ${q} 组查询）——`);
  console.log(`解析+分析器构建(含LCA索引): ${ms(b0, b1)} ms`);
  console.log(`生成查询: ${ms(b1, b2)} ms`);
  console.log(`整批查询: ${ms(b2, b3)} ms`);
  console.log(`分析器构建+整批查询合计: ${ms(b0, b3)} ms`);

  const budget = 5000;
  if (b3 - b0 > budget) {
    console.error(`批量筛选超出 ${budget}ms 预算`);
    process.exit(1);
  }
  console.log(`OK：批量筛选在上限 ${budget}ms 预算内完成，${q} 项计数全部等于距离`);
}

main();
