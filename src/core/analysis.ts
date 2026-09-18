/**
 * 脆弱链路（桥）分析与单条虚拟备纤试接。
 *
 * 算法：
 *  - Tarjan 桥检测（无向图，支持平行链路），显式栈迭代实现，
 *    200k 站点 / 400k 链路规模下不占用 JS 递归调用栈；
 *  - DFS 同时统计子树规模，桥断开后较小侧 = min(子树, n − 子树)；
 *  - 桥构成“桥树”：新增边 (a,b) 恰好覆盖 a↔b 在 DFS 树上路径经过的
 *    全部桥（树路径即桥树路径），其余桥仍脆弱。
 *
 * 时间复杂度 O(V+E)，空间 O(V+E)。邻接表使用紧凑类型化数组，
 * 避免约 80 万条邻接记录的装箱开销。Analyzer 只做一次准备与一次
 * Tarjan；试接在其结果上以独立缓冲派生，绝不改写基线。
 */
import { compareUtf8 } from './utf8';
import { MAX_BATCH_PAIRS } from './parse';
import { TopologyError } from './types';
import type {
  BaselineResult,
  BatchPair,
  BatchScreenItem,
  BatchScreenResult,
  BridgeInfo,
  NormalizedTopology,
  TrialResult,
} from './types';

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
  /** DFS 发现序：order[disc[v]] = v，保证父顶点先于子顶点出现 */
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
 * 只读批量索引：基于 Tarjan 父树与桥标记构建的桥前缀 + 二进制提升表。
 * 构造一次后仅被读取，批量筛选与单次试接共享，绝不改写基线数据。
 */
interface LcaIndex {
  /** DFS 树深度（根为 0），与 PreparedGraph.depth 共享同一缓冲 */
  depth: Int32Array;
  /** 桥前缀：根到 v 的树路径上的桥数量 */
  bridgePrefix: Int32Array;
  /** 扁平二进制提升表：up[k * n + v] 为 v 的第 2^k 个祖先（根的祖先为其自身） */
  up: Int32Array;
  levels: number;
}

/** 构建只读 LCA 索引：O(n log n)，全程迭代 */
function buildLcaIndex(g: PreparedGraph, tj: TarjanOutput): LcaIndex {
  const { n, parentVertex, parentEdge, depth } = g;
  const { isBridge, order } = tj;

  // 桥前缀：按 DFS 发现序（父先于子）累加“父边是否为桥”
  const bridgePrefix = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const v = order[i];
    const p = parentVertex[v];
    if (p !== -1) {
      bridgePrefix[v] = bridgePrefix[p] + isBridge[parentEdge[v]];
    }
  }

  // 二进制提升：up[0][v] = 父顶点（根指向自身），up[k][v] = up[k-1][up[k-1][v]]
  const levels = Math.max(1, 32 - Math.clz32(n - 1));
  const up = new Int32Array(levels * n);
  for (let v = 0; v < n; v++) {
    const p = parentVertex[v];
    up[v] = p === -1 ? v : p;
  }
  for (let k = 1; k < levels; k++) {
    const prev = (k - 1) * n;
    const cur = k * n;
    for (let v = 0; v < n; v++) {
      up[cur + v] = up[prev + up[prev + v]];
    }
  }
  return { depth, bridgePrefix, up, levels };
}

/** 迭代式最近公共祖先（二进制提升），不占用递归调用栈 */
function lcaOf(idx: LcaIndex, u0: number, v0: number): number {
  const { depth, up, levels } = idx;
  const n = depth.length;
  let u = u0;
  let v = v0;
  if (depth[u] < depth[v]) {
    const t = u;
    u = v;
    v = t;
  }
  // 将较深一端提升到同深
  let diff = depth[u] - depth[v];
  let k = 0;
  while (diff !== 0) {
    if ((diff & 1) !== 0) u = up[k * n + u];
    diff >>>= 1;
    k++;
  }
  if (u === v) return u;
  // 自高向低同步提升，直到二者父顶点相同
  for (let j = levels - 1; j >= 0; j--) {
    const uu = up[j * n + u];
    const vv = up[j * n + v];
    if (uu !== vv) {
      u = uu;
      v = vv;
    }
  }
  return up[u];
}

/** 一次导入对应的完整分析器；基线结果在构造时固定，试接不可改写它。 */
export class Analyzer {
  private readonly g: PreparedGraph;
  private readonly tj: TarjanOutput;
  /** 只读批量索引（桥前缀 + 二进制提升表），构造时一次建成 */
  private readonly lca: LcaIndex;
  readonly baseline: BaselineResult;

  constructor(private readonly t: NormalizedTopology) {
    this.g = prepare(t);
    this.tj = tarjanBridges(this.g, t.links.length);
    this.lca = buildLcaIndex(this.g, this.tj);
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
   * 批量方案筛选：对整批端点对给出各自可消除的基线桥数量（不展开链路清单）。
   *
   * 全批校验（端点存在且互异）全部通过后才开始计数，任一非法即按下标
   * 抛出 TopologyError、不产生任何部分结果；成功时一次性返回整体结果。
   * 每项计数 = bridgePrefix[u] + bridgePrefix[v] − 2·bridgePrefix[lca(u,v)]，
   * 即试接 (u,v) 在桥树路径上覆盖的桥数，与 trial(u,v).removed.length 一致。
   * 全程只读共享 LCA 索引：不循环调用 trial、不为单项分配链路长度缓冲、
   * 不扫描全部链路，每项 O(log n)。
   */
  screenBatch(pairs: BatchPair[]): BatchScreenResult {
    const count = pairs.length;
    if (count === 0) {
      throw new TopologyError('批量方案不能为空：至少包含 1 项端点对');
    }
    if (count > MAX_BATCH_PAIRS) {
      throw new TopologyError(`批量方案项数超过上限 ${MAX_BATCH_PAIRS}，当前为 ${count}`);
    }

    // 第一遍：全批校验并解析端点下标；任何一项非法都按下标报错
    const va = new Int32Array(count);
    const vb = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const { a, b } = pairs[i];
      if (a === b) {
        throw new TopologyError(`批量方案下标 ${i}：两个端点必须不同（均为 ${JSON.stringify(a)}），不得构成自环`);
      }
      const ia = this.g.siteIndex.get(a);
      const ib = this.g.siteIndex.get(b);
      if (ia === undefined || ib === undefined) {
        const missing = ia === undefined ? a : b;
        throw new TopologyError(`批量方案下标 ${i}：端点 ${JSON.stringify(missing)} 不在当前站点清单中`);
      }
      va[i] = ia;
      vb[i] = ib;
    }

    // 第二遍：校验全部通过后，基于只读索引批量计数（重复候选按原序保留）
    const { bridgePrefix } = this.lca;
    const items: BatchScreenItem[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const u = va[i];
      const v = vb[i];
      const w = lcaOf(this.lca, u, v);
      items[i] = {
        index: i,
        a: pairs[i].a,
        b: pairs[i].b,
        removedCount: bridgePrefix[u] + bridgePrefix[v] - 2 * bridgePrefix[w],
      };
    }
    return { items, baselineCount: this.baseline.bridges.length };
  }
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
