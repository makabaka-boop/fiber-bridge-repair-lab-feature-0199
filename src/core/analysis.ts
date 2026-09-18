/**
 * 脆弱链路（桥）分析、单条虚拟备纤试接与批量方案筛选。
 *
 * 算法：
 *  - Tarjan 桥检测（无向图，支持平行链路），显式栈迭代实现，
 *    200k 站点 / 400k 链路规模下不占用 JS 递归调用栈；
 *  - DFS 同时统计子树规模，桥断开后较小侧 = min(子树, n − 子树)；
 *  - 桥构成“桥树”：新增边 (a,b) 恰好覆盖 a↔b 在 DFS 树上路径经过的
 *    全部桥（树路径即桥树路径），其余桥仍脆弱；
 *  - 批量筛选复用同一结论：构造时基于 Tarjan 父树与桥标记构建只读
 *    桥前缀（根到各顶点的桥数前缀）与二进制提升索引，逐项以最近公共
 *    祖先 O(log V) 计数，不循环调用 trial、不逐项分配 links 长度缓冲。
 *
 * 时间复杂度 O(V+E)，空间 O(V+E)。邻接表使用紧凑类型化数组，
 * 避免约 80 万条邻接记录的装箱开销。Analyzer 只做一次准备与一次
 * Tarjan；试接与批量筛选在其结果上派生，绝不改写基线。
 */
import { compareUtf8 } from './utf8';
import { TopologyError } from './types';
import type {
  BaselineResult,
  BatchItemResult,
  BatchResult,
  BridgeInfo,
  NormalizedTopology,
  TrialResult,
} from './types';

/** 批量方案筛选的候选条数上限 */
export const MAX_BATCH_CANDIDATES = 100_000;

interface PreparedGraph {
  n: number;
  siteIndex: Map<string, number>;
  linkIdByIndex: string[];
  links: NormalizedTopology['links'];
  /** 每个顶点两条平行的类型化邻接数组：端点下标 / 链路下标 */
  adjTo: Int32Array[];
  adjEdge: Int32Array[];
  /** DFS 树：父顶点、所用链路下标（根为 -1）、深度 */
  parentVertex: Int32Array;
  parentEdge: Int32Array;
  depth: Int32Array;
}

interface TarjanOutput {
  isBridge: Uint8Array;
  /** 桥 e 在 DFS 树中的子端点（非桥为 -1） */
  bridgeChild: Int32Array;
  subtree: Int32Array;
  /** DFS 发现序：order[disc[v]] = v，父顶点必先于子顶点出现 */
  order: Int32Array;
}

function prepare(t: NormalizedTopology): PreparedGraph {
  const n = t.sites.length;
  const siteIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) siteIndex.set(t.sites[i], i);

  const m = t.links.length;
  const degree = new Int32Array(n);
  for (const l of t.links) {
    degree[siteIndex.get(l.u)!]++;
    degree[siteIndex.get(l.v)!]++;
  }
  const adjTo: Int32Array[] = new Array(n);
  const adjEdge: Int32Array[] = new Array(n);
  for (let i = 0; i < n; i++) {
    adjTo[i] = new Int32Array(degree[i]);
    adjEdge[i] = new Int32Array(degree[i]);
  }
  const cursor = new Int32Array(n);
  const linkIdByIndex = new Array<string>(m);
  for (let e = 0; e < m; e++) {
    const l = t.links[e];
    linkIdByIndex[e] = l.id;
    const a = siteIndex.get(l.u)!;
    const b = siteIndex.get(l.v)!;
    adjTo[a][cursor[a]] = b;
    adjEdge[a][cursor[a]] = e;
    cursor[a]++;
    adjTo[b][cursor[b]] = a;
    adjEdge[b][cursor[b]] = e;
    cursor[b]++;
  }

  return {
    n,
    siteIndex,
    linkIdByIndex,
    links: t.links,
    adjTo,
    adjEdge,
    parentVertex: new Int32Array(n),
    parentEdge: new Int32Array(n),
    depth: new Int32Array(n),
  };
}

/** 迭代式 Tarjan。图已由解析层保证连通，仍对多分量做防御性遍历。 */
function tarjanBridges(g: PreparedGraph, m: number): TarjanOutput {
  const { n, adjTo, adjEdge, parentVertex, parentEdge, depth } = g;
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const subtree = new Int32Array(n).fill(1);
  const isBridge = new Uint8Array(m);
  const bridgeChild = new Int32Array(m).fill(-1);
  const order = new Int32Array(n);
  const nextCursor = new Int32Array(n); // 每个顶点下一条待考察邻接边
  const stack = new Int32Array(n);

  let timer = 0;
  for (let root = 0; root < n; root++) {
    if (disc[root] !== -1) continue;
    disc[root] = low[root] = timer++;
    order[disc[root]] = root;
    parentVertex[root] = -1;
    parentEdge[root] = -1;
    depth[root] = 0;
    let top = 0;
    stack[top++] = root;

    while (top > 0) {
      const v = stack[top - 1];
      if (nextCursor[v] < adjTo[v].length) {
        const k = nextCursor[v]++;
        const w = adjTo[v][k];
        const eid = adjEdge[v][k];
        // 仅跳过“通向父顶点的同一条树边”；平行边不跳过，
        // 这正是两条平行链路都不成为桥的原因。
        if (eid === parentEdge[v]) continue;
        if (disc[w] === -1) {
          parentVertex[w] = v;
          parentEdge[w] = eid;
          depth[w] = depth[v] + 1;
          disc[w] = low[w] = timer++;
          order[disc[w]] = w;
          stack[top++] = w;
        } else if (disc[w] < low[v]) {
          // 回边（含通向祖先的平行边）降低 low 值
          low[v] = disc[w];
        }
      } else {
        // v 全部邻接考察完毕，收尾：传播 low 与子树规模并判桥
        top--;
        const p = parentVertex[v];
        if (p !== -1) {
          if (low[v] < low[p]) low[p] = low[v];
          subtree[p] += subtree[v];
          if (low[v] > disc[p]) {
            const eid = parentEdge[v];
            isBridge[eid] = 1;
            bridgeChild[eid] = v;
          }
        }
      }
    }
  }
  return { isBridge, bridgeChild, subtree, order };
}

/**
 * 批量方案筛选用的只读索引（构建后不再改写）：
 *  - pref[v]：根到 v 的 DFS 树路径上的桥数量（“桥前缀”）；
 *  - up[k][v]：v 向上 2^k 步的祖先（二进制提升表，无则为 -1）。
 * 端点对 (a,b) 消除的桥数 = pref[a] + pref[b] − 2·pref[lca(a,b)]，
 * 与单次试接 trial 的树路径标记完全等价，但每项只需 O(log V)，
 * 不分配 links 长度缓冲、不扫描全部链路。
 */
interface LcaIndex {
  up: Int32Array[];
  pref: Int32Array;
  log: number;
}

function buildLcaIndex(g: PreparedGraph, tj: TarjanOutput): LcaIndex {
  const { n, parentVertex, parentEdge } = g;
  const { isBridge, order } = tj;

  // 桥前缀：按 DFS 发现序推进，父顶点必先于子顶点就绪
  const pref = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const v = order[i];
    const p = parentVertex[v];
    if (p === -1) continue; // 树根：前缀为 0
    pref[v] = pref[p] + (isBridge[parentEdge[v]] === 1 ? 1 : 0);
  }

  let log = 1;
  while ((1 << log) <= n) log++;
  const up: Int32Array[] = new Array(log);
  up[0] = Int32Array.from(parentVertex);
  for (let k = 1; k < log; k++) {
    const prev = up[k - 1];
    const cur = new Int32Array(n);
    for (let v = 0; v < n; v++) {
      const mid = prev[v];
      cur[v] = mid === -1 ? -1 : prev[mid];
    }
    up[k] = cur;
  }
  return { up, pref, log };
}

/** 一次导入对应的完整分析器；基线结果在构造时固定，试接不可改写它。 */
export class Analyzer {
  private readonly g: PreparedGraph;
  private readonly tj: TarjanOutput;
  private readonly lcaIndex: LcaIndex;
  readonly baseline: BaselineResult;

  constructor(private readonly t: NormalizedTopology) {
    this.g = prepare(t);
    this.tj = tarjanBridges(this.g, t.links.length);
    // 合法导入即基于 Tarjan 父树与桥标记构建只读桥前缀 + 二进制提升索引
    this.lcaIndex = buildLcaIndex(this.g, this.tj);
    this.baseline = this.buildBaseline();
  }

  private buildBaseline(): BaselineResult {
    const { isBridge, bridgeChild, subtree } = this.tj;
    const bridges: BridgeInfo[] = [];
    for (let e = 0; e < this.t.links.length; e++) {
      if (!isBridge[e]) continue;
      const link = this.t.links[e];
      const side = subtree[bridgeChild[e]];
      bridges.push({ id: link.id, u: link.u, v: link.v, smallerSide: Math.min(side, this.g.n - side) });
    }
    bridges.sort((x, y) => compareUtf8(x.id, y.id));
    return { siteCount: this.g.n, linkCount: this.t.links.length, bridges };
  }

  /**
   * 试接一条虚拟备纤 (a,b)。返回新的 TrialResult，不修改基线。
   * 端点非法抛 TopologyError，由调用方保留上次试接结果并提示。
   */
  trial(rawA: unknown, rawB: unknown): TrialResult {
    const a = normalizeEndpoint(rawA, '端点 A');
    const b = normalizeEndpoint(rawB, '端点 B');
    if (a === b) {
      throw new TopologyError(`试接失败：两个端点必须不同（均为 ${JSON.stringify(a)}），不得构成自环`);
    }
    const ia = this.g.siteIndex.get(a);
    const ib = this.g.siteIndex.get(b);
    if (ia === undefined || ib === undefined) {
      const missing = ia === undefined ? a : b;
      throw new TopologyError(`试接失败：端点 ${JSON.stringify(missing)} 不在当前站点清单中`);
    }

    const { parentEdge, parentVertex, depth } = this.g;
    const { isBridge } = this.tj;
    // onPath 为本次试接独立缓冲，绝不触碰基线数据
    const onPath = new Uint8Array(this.t.links.length);
    let x = ia;
    let y = ib;
    const mark = (v: number): void => {
      const e = parentEdge[v];
      if (e !== -1) onPath[e] = 1;
    };
    while (depth[x] > depth[y]) {
      mark(x);
      x = parentVertex[x];
    }
    while (depth[y] > depth[x]) {
      mark(y);
      y = parentVertex[y];
    }
    while (x !== y) {
      mark(x);
      x = parentVertex[x];
      mark(y);
      y = parentVertex[y];
    }

    const removedIds = new Set<string>();
    for (let e = 0; e < this.t.links.length; e++) {
      if (isBridge[e] && onPath[e]) removedIds.add(this.g.linkIdByIndex[e]);
    }

    const stillFragile: BridgeInfo[] = [];
    const removed: BridgeInfo[] = [];
    for (const info of this.baseline.bridges) {
      (removedIds.has(info.id) ? removed : stillFragile).push(info);
    }
    stillFragile.sort((p, q) => compareUtf8(p.id, q.id));
    removed.sort((p, q) => compareUtf8(p.id, q.id));

    return { a, b, stillFragile, removed, baselineCount: this.baseline.bridges.length };
  }

  /**
   * 批量方案筛选：粘贴 1–100000 项的 JSON 数组文本，每项仅含 a、b 两个
   * 沿用单次试接规则的站点编号。整批先校验结构、字段、端点存在且互异，
   * 任一项非法即按下标抛出 TopologyError 且不产生任何结果；全部合法后
   * 才用 LCA 索引逐项计数并一次性返回（重复候选按原序保留）。
   * 不循环调用 trial、不为单项分配 links 长度缓冲、不扫描全部链路；
   * 基线与单次试接结果均不受本方法影响。
   */
  batch(jsonText: string): BatchResult {
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch (e) {
      throw new TopologyError(`批量方案 JSON 语法错误：${(e as Error).message}`);
    }
    if (!Array.isArray(raw)) {
      throw new TopologyError('批量方案必须是一个 JSON 数组，形如 [{"a":"s1","b":"s2"}, ...]');
    }
    if (raw.length === 0) {
      throw new TopologyError('批量方案不能为空数组，至少提供 1 项候选');
    }
    if (raw.length > MAX_BATCH_CANDIDATES) {
      throw new TopologyError(`批量方案条数超过上限 ${MAX_BATCH_CANDIDATES}，当前为 ${raw.length}，整批拒绝`);
    }

    // 第一遍：全批校验（结构、字段、端点存在且互异），不产出任何结果
    const pairs = new Array<{ a: string; b: string }>(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const where = `批量方案下标 ${i}`;
      const entry = raw[i];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new TopologyError(`${where}必须是对象，形如 {"a": ..., "b": ...}`);
      }
      const obj = entry as Record<string, unknown>;
      if (!('a' in obj)) throw new TopologyError(`${where}缺少字段 "a"`);
      if (!('b' in obj)) throw new TopologyError(`${where}缺少字段 "b"`);
      for (const key of Object.keys(obj)) {
        if (key !== 'a' && key !== 'b') {
          throw new TopologyError(`${where}含额外字段 ${JSON.stringify(key)}，每项仅允许 "a" 与 "b"，整批拒绝`);
        }
      }
      const a = normalizeBatchEndpoint(obj.a, where, 'a');
      const b = normalizeBatchEndpoint(obj.b, where, 'b');
      if (a === b) {
        throw new TopologyError(`${where}两个端点必须不同（均为 ${JSON.stringify(a)}），不得构成自环`);
      }
      if (!this.g.siteIndex.has(a) || !this.g.siteIndex.has(b)) {
        const missing = this.g.siteIndex.has(a) ? b : a;
        throw new TopologyError(`${where}端点 ${JSON.stringify(missing)} 不在当前站点清单中`);
      }
      pairs[i] = { a, b };
    }

    // 第二遍：全批合法后才计数，逐项 O(log V)，一次生成整体结果
    const items = new Array<BatchItemResult>(pairs.length);
    for (let i = 0; i < pairs.length; i++) {
      const ia = this.g.siteIndex.get(pairs[i].a)!;
      const ib = this.g.siteIndex.get(pairs[i].b)!;
      items[i] = { index: i, a: pairs[i].a, b: pairs[i].b, removedCount: this.countRemoved(ia, ib) };
    }
    return { items, baselineCount: this.baseline.bridges.length };
  }

  /** 试接 (ia,ib) 可消除的桥数 = 树路径上的桥数 = pref[a] + pref[b] − 2·pref[lca] */
  private countRemoved(ia: number, ib: number): number {
    const c = this.lca(ia, ib);
    if (c === -1) {
      // 解析层已保证原图连通，此处仅为防御
      throw new TopologyError('批量方案失败：端点不在同一连通分量');
    }
    const { pref } = this.lcaIndex;
    return pref[ia] + pref[ib] - 2 * pref[c];
  }

  /** 二进制提升求最近公共祖先（迭代实现，不递归） */
  private lca(u: number, v: number): number {
    const { up, log } = this.lcaIndex;
    const { depth, parentVertex } = this.g;
    let x = u;
    let y = v;
    if (depth[x] < depth[y]) {
      const tmp = x;
      x = y;
      y = tmp;
    }
    let diff = depth[x] - depth[y];
    for (let k = 0; diff !== 0; k++, diff >>>= 1) {
      if (diff & 1) x = up[k][x];
    }
    if (x === y) return x;
    for (let k = log - 1; k >= 0; k--) {
      const ux = up[k][x];
      const uy = up[k][y];
      if (ux !== uy) {
        x = ux;
        y = uy;
      }
    }
    return parentVertex[x];
  }
}

/** 批量候选的端点规范化：与单次试接同一套规则（字符串去空白、整数编号转文本） */
function normalizeBatchEndpoint(value: unknown, where: string, field: string): string {
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.length === 0) throw new TopologyError(`${where}字段 "${field}" 为空`);
    return s;
  }
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return String(value);
  }
  throw new TopologyError(`${where}字段 "${field}" 必须是已存在的站点编号（字符串或整数）`);
}

function normalizeEndpoint(value: unknown, label: string): string {
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.length === 0) throw new TopologyError(`试接失败：${label}为空`);
    return s;
  }
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return String(value);
  }
  throw new TopologyError(`试接失败：${label}必须是已存在的站点编号`);
}
