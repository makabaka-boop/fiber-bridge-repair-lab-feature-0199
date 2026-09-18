import { describe, expect, it } from 'vitest';
import { Analyzer, MAX_BATCH_CANDIDATES } from './analysis';
import { oracleBaseline, oracleTrial } from './oracle';
import { Rng } from './rng';
import { randomConnectedGraph } from './testGraph';
import type { NormalizedTopology } from './types';

/** 构造 n 个站点的长链：s0—s1—…—s(n-1)，每条链路都是桥 */
function chainTopology(n: number): NormalizedTopology {
  const sites = new Array<string>(n);
  for (let i = 0; i < n; i++) sites[i] = `s${i}`;
  const links = new Array<{ id: string; u: string; v: string }>(n - 1);
  for (let i = 1; i < n; i++) links[i - 1] = { id: `c${i}`, u: sites[i - 1], v: sites[i] };
  return { sites, links };
}

describe('批量方案筛选：随机多重小图差分（删边预言机核对）', () => {
  it('每项计数与 trial(a,b).removed.length 一致，trial 与预言机一致', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rng = new Rng(seed * 2654435761 + 7);
      const g = randomConnectedGraph(rng, 2 + rng.int(9), rng.int(12));
      const analyzer = new Analyzer(g);
      // 基线先过删边预言机
      expect(analyzer.baseline.bridges.map((b) => b.id)).toEqual(oracleBaseline(g).bridges.map((b) => b.id));

      const pairs: { a: string; b: string }[] = [];
      for (let k = 0; k < 6; k++) {
        const a = g.sites[rng.int(g.sites.length)];
        let b = g.sites[rng.int(g.sites.length)];
        while (b === a) b = g.sites[rng.int(g.sites.length)];
        pairs.push({ a, b });
      }
      pairs.push(pairs[0]); // 重复候选：按原序保留

      const result = analyzer.batch(JSON.stringify(pairs));
      expect(result.baselineCount).toBe(analyzer.baseline.bridges.length);
      expect(result.items).toHaveLength(pairs.length);
      for (let i = 0; i < pairs.length; i++) {
        const trial = analyzer.trial(pairs[i].a, pairs[i].b);
        // 删边预言机核对单次试接明细
        const want = oracleTrial(g, analyzer.baseline, pairs[i].a, pairs[i].b);
        expect(new Set(trial.removed.map((x) => x.id))).toEqual(want.removed);
        // 批量计数与单次试接一致，且下标/端点对保持输入原序
        expect(result.items[i].removedCount).toBe(trial.removed.length);
        expect(result.items[i].index).toBe(i);
        expect(result.items[i].a).toBe(pairs[i].a);
        expect(result.items[i].b).toBe(pairs[i].b);
      }
    }
  });

  it('整数编号端点沿用单次试接规则', () => {
    // 站点编号 "0".."4" 的长链，链路全为桥
    const g: NormalizedTopology = {
      sites: ['0', '1', '2', '3', '4'],
      links: [0, 1, 2, 3].map((i) => ({ id: `c${i}`, u: String(i), v: String(i + 1) })),
    };
    const analyzer = new Analyzer(g);
    const result = analyzer.batch(JSON.stringify([{ a: 0, b: 4 }, { a: '1', b: ' 2 ' }]));
    expect(result.items[0]).toEqual({ index: 0, a: '0', b: '4', removedCount: 4 });
    expect(result.items[1]).toEqual({ index: 1, a: '1', b: '2', removedCount: 1 });
  });
});

describe('批量方案筛选：整批校验', () => {
  const g = chainTopology(6);
  const analyzer = new Analyzer(g);

  it('拒绝非数组 / 空批次 / 超限', () => {
    expect(() => analyzer.batch('{"a":"s1"}')).toThrow(/必须是一个 JSON 数组/);
    expect(() => analyzer.batch('[]')).toThrow(/不能为空数组/);
    const over = new Array(MAX_BATCH_CANDIDATES + 1).fill({ a: 's0', b: 's1' });
    expect(() => analyzer.batch(JSON.stringify(over))).toThrow(/超过上限/);
    expect(() => analyzer.batch('[{"a":"s0",')).toThrow(/JSON 语法错误/);
  });

  it('按下标报告非法项：结构 / 字段 / 端点', () => {
    expect(() => analyzer.batch('[1]')).toThrow(/下标 0.*必须是对象/);
    expect(() => analyzer.batch('[null]')).toThrow(/下标 0.*必须是对象/);
    expect(() => analyzer.batch('[{"a":"s0","b":"s1"},["s0","s1"]]')).toThrow(/下标 1.*必须是对象/);
    expect(() => analyzer.batch('[{"a":"s0"}]')).toThrow(/下标 0.*缺少字段 "b"/);
    expect(() => analyzer.batch('[{"b":"s1"}]')).toThrow(/下标 0.*缺少字段 "a"/);
    expect(() => analyzer.batch('[{"a":"s0","b":"s1","note":1}]')).toThrow(/下标 0.*额外字段/);
    expect(() => analyzer.batch('[{"a":"s2","b":"s2"}]')).toThrow(/下标 0.*必须不同/);
    expect(() => analyzer.batch('[{"a":"s0","b":"ghost"}]')).toThrow(/下标 0.*不在当前站点清单/);
    expect(() => analyzer.batch('[{"a":"  ","b":"s1"}]')).toThrow(/下标 0.*为空/);
    expect(() => analyzer.batch('[{"a":null,"b":"s1"}]')).toThrow(/下标 0.*站点编号/);
    expect(() => analyzer.batch('[{"a":true,"b":"s1"}]')).toThrow(/下标 0.*站点编号/);
  });

  it('末项非法时无部分结果，分析器状态不被污染', () => {
    const baselineBefore = JSON.stringify(analyzer.baseline);
    const good = [
      { a: 's0', b: 's5' },
      { a: 's1', b: 's3' },
    ];
    const ok = analyzer.batch(JSON.stringify(good));
    expect(ok.items.map((x) => x.removedCount)).toEqual([5, 2]);

    // 末项非法：整批拒绝，报错定位到末项下标
    const bad = [...good, { a: 's0', b: 'ghost' }];
    expect(() => analyzer.batch(JSON.stringify(bad))).toThrow(/下标 2.*不在当前站点清单/);

    // 无部分结果：分析器不被污染，基线/单次试接/后续合法批量均不受影响
    expect(JSON.stringify(analyzer.baseline)).toBe(baselineBefore);
    expect(analyzer.batch(JSON.stringify(good))).toEqual(ok);
    expect(analyzer.trial('s0', 's5').removed).toHaveLength(5);
  });

  it('批量筛选不改写基线与单次试接结果', () => {
    const before = JSON.stringify(analyzer.baseline);
    const t1 = analyzer.trial('s0', 's4');
    analyzer.batch(JSON.stringify([{ a: 's0', b: 's5' }, { a: 's2', b: 's4' }]));
    expect(JSON.stringify(analyzer.baseline)).toBe(before);
    expect(analyzer.trial('s0', 's4')).toEqual(t1);
  });
});

describe('批量方案筛选：上限规模（200000 站点长链 × 100000 组查询）', () => {
  it(
    '距离计数正确，分析器构建 + 整批查询在 5 秒内完成（全程迭代不递归）',
    { timeout: 30000 },
    () => {
      const n = 200_000;
      const t = chainTopology(n);

      // 确定性随机 100000 组端点对
      const rng = new Rng(0x2026_0918);
      const pairs = new Array<{ a: string; b: string; d: number }>(MAX_BATCH_CANDIDATES);
      for (let i = 0; i < pairs.length; i++) {
        const x = rng.int(n);
        let y = rng.int(n);
        while (y === x) y = rng.int(n);
        pairs[i] = { a: `s${x}`, b: `s${y}`, d: Math.abs(x - y) };
      }
      const json = JSON.stringify(pairs.map(({ a, b }) => ({ a, b })));

      const t0 = performance.now();
      const analyzer = new Analyzer(t);
      const result = analyzer.batch(json);
      const elapsed = performance.now() - t0;

      // 长链上每条链路都是桥，可消除数量 = 端点间距离
      expect(analyzer.baseline.bridges).toHaveLength(n - 1);
      expect(result.items).toHaveLength(pairs.length);
      for (let i = 0; i < pairs.length; i++) {
        expect(result.items[i].removedCount).toBe(pairs[i].d);
      }
      expect(elapsed).toBeLessThan(5000);
    },
  );
});
