/**
 * 导入契约解析与严格校验。
 *
 * 仅接受普通 JSON 基础类型；所有错误均以 TopologyError 抛出中文消息，
 * 由 UI 保留上次有效拓扑并显示。
 */
import { TopologyError, type BatchPair, type NormalizedLink, type NormalizedTopology } from './types';

export const MAX_SITES = 200_000;
export const MAX_LINKS = 400_000;
export const MIN_SITES = 2;
/** 批量方案筛选：单次导入的端点对数量上限 */
export const MAX_BATCH_PAIRS = 100_000;

/**
 * 将一个 JSON 值规范化为非空字符串编号。
 * 允许字符串或“安全整数范围内的数字”（数字编号按十进制文本承载），
 * 拒绝布尔、null、对象、数组、空串、NaN/Infinity。
 */
export function normalizeId(value: unknown, label: string): string {
  if (typeof value === 'string') {
    if (value.length === 0) {
      throw new TopologyError(`${label}不能为空字符串`);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new TopologyError(`${label}必须是整数或非空字符串`);
    }
    return String(value);
  }
  throw new TopologyError(`${label}必须是字符串或整数编号`);
}

function expectObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TopologyError('导入文件必须是一个 JSON 对象，形如 {"sites": [...], "links": [...]}');
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TopologyError(`${label}必须是数组`);
  }
  return value;
}

/**
 * 解析并校验原始 JSON 文本。
 * 校验规则：
 *  - 顶层为 {"sites": [...], "links": [...]}；
 *  - 站点 2–200000 个，编号唯一且非空；
 *  - 链路至多 400000 条，编号唯一且非空；
 *  - 每条链路端点必须存在、不得自环；平行链路合法；
 *  - 原图必须连通。
 */
export function parseTopology(jsonText: string): NormalizedTopology {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    throw new TopologyError(`JSON 语法错误：${(e as Error).message}`);
  }

  const obj = expectObject(raw);
  if (!('sites' in obj)) throw new TopologyError('缺少必填字段 "sites"');
  if (!('links' in obj)) throw new TopologyError('缺少必填字段 "links"');

  const rawSites = expectArray(obj.sites, 'sites');
  const rawLinks = expectArray(obj.links, 'links');

  if (rawSites.length < MIN_SITES) {
    throw new TopologyError(`站点数至少为 ${MIN_SITES}，当前为 ${rawSites.length}`);
  }
  if (rawSites.length > MAX_SITES) {
    throw new TopologyError(`站点数超过上限 ${MAX_SITES}，当前为 ${rawSites.length}`);
  }
  if (rawLinks.length > MAX_LINKS) {
    throw new TopologyError(`链路数超过上限 ${MAX_LINKS}，当前为 ${rawLinks.length}`);
  }

  // 站点：非空 + 唯一
  const sites: string[] = new Array(rawSites.length);
  const siteSet: Set<string> = new Set();
  for (let i = 0; i < rawSites.length; i++) {
    const id = normalizeId(rawSites[i], `第 ${i + 1} 个站点编号`);
    if (siteSet.has(id)) {
      throw new TopologyError(`站点编号重复：${JSON.stringify(id)}`);
    }
    siteSet.add(id);
    sites[i] = id;
  }

  // 链路：对象结构、唯一编号、端点合法、禁止自环
  const links: NormalizedLink[] = new Array(rawLinks.length);
  const linkIds: Set<string> = new Set();
  for (let i = 0; i < rawLinks.length; i++) {
    const entry = rawLinks[i];
    const where = `第 ${i + 1} 条链路`;
    const linkObj = expectObject(entry);
    if (!('id' in linkObj)) throw new TopologyError(`${where}缺少字段 "id"`);
    if (!('u' in linkObj)) throw new TopologyError(`${where}缺少字段 "u"`);
    if (!('v' in linkObj)) throw new TopologyError(`${where}缺少字段 "v"`);

    const id = normalizeId(linkObj.id, `${where}的编号`);
    if (linkIds.has(id)) {
      throw new TopologyError(`链路编号重复：${JSON.stringify(id)}`);
    }
    linkIds.add(id);

    const u = normalizeId(linkObj.u, `${where}（${id}）的端点 u`);
    const v = normalizeId(linkObj.v, `${where}（${id}）的端点 v`);
    if (!siteSet.has(u) || !siteSet.has(v)) {
      throw new TopologyError(
        `链路 ${JSON.stringify(id)} 的端点 ${JSON.stringify(!siteSet.has(u) ? u : v)} 不在站点清单中`,
      );
    }
    if (u === v) {
      throw new TopologyError(`链路 ${JSON.stringify(id)} 为自环（u 与 v 均为 ${JSON.stringify(u)}），自环非法`);
    }
    links[i] = { id, u, v };
  }

  const topology = { sites, links };
  assertConnected(topology);
  return topology;
}

/**
 * 批量方案端点编号规范化：沿用单次试接规则——字符串去首尾空白后非空，
 * 或安全整数按其十进制文本承载；其余类型（布尔、null、对象、数组、
 * NaN/Infinity）一律拒绝。
 */
function normalizeBatchEndpoint(value: unknown, label: string): string {
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.length === 0) {
      throw new TopologyError(`${label}为空`);
    }
    return s;
  }
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return String(value);
  }
  throw new TopologyError(`${label}必须是非空字符串或整数站点编号`);
}

/**
 * 解析批量方案筛选输入：一个 1–100000 项的 JSON 数组，每项为**仅含**
 * "a"、"b" 两个字段的对象（端点编号沿用单次试接规则）。
 *
 * 仅做结构与字段校验；端点存在性、互异性由 Analyzer.screenBatch
 * 针对当前拓扑校验。空批次、额外字段、超限、任一项非法均整体拒绝，
 * 错误消息携带输入下标（0 起）。
 */
export function parseBatchPlans(jsonText: string): BatchPair[] {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    throw new TopologyError(`JSON 语法错误：${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) {
    throw new TopologyError('批量方案必须是一个 JSON 数组，形如 [{"a": "站点1", "b": "站点2"}, ...]');
  }
  if (raw.length === 0) {
    throw new TopologyError('批量方案不能为空数组：至少包含 1 项端点对');
  }
  if (raw.length > MAX_BATCH_PAIRS) {
    throw new TopologyError(`批量方案项数超过上限 ${MAX_BATCH_PAIRS}，当前为 ${raw.length}`);
  }

  const pairs: BatchPair[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const where = `批量方案下标 ${i}`;
    const entry = raw[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TopologyError(`${where}：每项必须是仅含 "a"、"b" 两个字段的对象`);
    }
    const obj = entry as Record<string, unknown>;
    if (!('a' in obj)) throw new TopologyError(`${where}：缺少字段 "a"`);
    if (!('b' in obj)) throw new TopologyError(`${where}：缺少字段 "b"`);
    const extra = Object.keys(obj).filter((k) => k !== 'a' && k !== 'b');
    if (extra.length > 0) {
      throw new TopologyError(`${where}：每项仅允许 "a"、"b" 两个字段，发现额外字段 ${JSON.stringify(extra[0])}`);
    }
    pairs[i] = {
      a: normalizeBatchEndpoint(obj.a, `${where} 的端点 a`),
      b: normalizeBatchEndpoint(obj.b, `${where} 的端点 b`),
    };
  }
  return pairs;
}

/** 连通性检查（显式栈迭代，避免深递归） */
function assertConnected(t: NormalizedTopology): void {
  const n = t.sites.length;
  const index = new Map<string, number>();
  for (let i = 0; i < n; i++) index.set(t.sites[i], i);

  const adj: Int32Array[] = new Array(n);
  const head = new Int32Array(n);
  // 先统计度数，再一次性分配邻接缓冲（紧凑且无装箱）
  for (const l of t.links) {
    head[index.get(l.u)!]++;
    head[index.get(l.v)!]++;
  }
  for (let i = 0; i < n; i++) {
    adj[i] = new Int32Array(head[i]);
    head[i] = 0;
  }
  for (const l of t.links) {
    const a = index.get(l.u)!;
    const b = index.get(l.v)!;
    adj[a][head[a]++] = b;
    adj[b][head[b]++] = a;
  }

  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  stack[top++] = 0;
  seen[0] = 1;
  let reached = 0;
  while (top > 0) {
    const x = stack[--top];
    reached++;
    const nb = adj[x];
    for (let k = 0; k < nb.length; k++) {
      const y = nb[k];
      if (!seen[y]) {
        seen[y] = 1;
        stack[top++] = y;
      }
    }
  }
  if (reached !== n) {
    throw new TopologyError(`原图必须连通：仅 ${reached}/${n} 个站点可达，存在孤立站点或分区`);
  }
}
