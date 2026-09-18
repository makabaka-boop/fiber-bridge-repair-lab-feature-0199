import { Rng } from './rng';
import type { NormalizedTopology } from './types';

/**
 * 生成随机连通无向多重图（仅测试用）：先生成一棵随机生成树保证连通，
 * 再追加随机边（允许平行边、允许重复同一对）。编号使用
 * 与插入顺序无关的字符串，强制考验 UTF-8 排序稳定性。
 */
export function randomConnectedGraph(rng: Rng, n: number, extraEdges: number): NormalizedTopology {
  const sites: string[] = [];
  for (let i = 0; i < n; i++) sites[i] = `S-${(1000 + i).toString(16)}`;
  // 打乱站点顺序，使邻接下标与编号序无关
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [sites[i], sites[j]] = [sites[j], sites[i]];
  }

  const raw: { id: string; u: string; v: string }[] = [];
  const usedIds = new Set<string>();
  let seq = 0;
  const newId = () => {
    let id: string;
    do {
      id = `e${(rng.int(9000) + 100).toString(36)}-${seq++}`;
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  // 随机生成树：顶点 1..n-1 连向某个更早的顶点
  const order = sites.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let i = 1; i < n; i++) {
    const u = order[i];
    const v = order[rng.int(i)];
    raw.push({ id: newId(), u, v });
  }
  // 追加随机边（可能产生平行链路、可能落在同一 2-边连通分量内）
  for (let k = 0; k < extraEdges; k++) {
    const u = sites[rng.int(n)];
    let v = sites[rng.int(n)];
    while (v === u) v = sites[rng.int(n)];
    raw.push({ id: newId(), u, v });
  }
  return { sites, links: raw };
}
