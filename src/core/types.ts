/**
 * 拓扑工作台核心数据类型。
 *
 * 输入仅允许普通 JSON 基础类型：字符串、数字（站点/链路编号均以字符串承载）、
 * 布尔值、null、数组、对象。解析后统一转换为下列内部类型。
 */

/** 原始导入结构（普通 JSON 对象） */
export interface RawTopology {
  /** 2–200000 个唯一非空站点编号 */
  sites: unknown[];
  /** 0–400000 条唯一编号的无向链路 */
  links: unknown[];
}

/** 规范化后的无向链路 */
export interface NormalizedLink {
  /** 链路编号（唯一、非空） */
  id: string;
  /** 端点站点编号（必须存在，u !== v） */
  u: string;
  v: string;
}

/** 规范化后的拓扑 */
export interface NormalizedTopology {
  /** 站点编号（保持导入顺序） */
  sites: string[];
  links: NormalizedLink[];
}

/** 单条脆弱链路（桥）的基线结论 */
export interface BridgeInfo {
  /** 链路编号 */
  id: string;
  /** 另一站点端点（便于核对，不输出站点清单） */
  u: string;
  v: string;
  /** 断开后两个连通块中较小者的站点数 */
  smallerSide: number;
}

/** 完整基线分析结果（试接不改写此结果） */
export interface BaselineResult {
  siteCount: number;
  linkCount: number;
  /** 按链路编号 UTF-8 字节序排序的全部脆弱链路 */
  bridges: BridgeInfo[];
}

/** 批量方案中的一项端点对（编号已按单次试接规则规范化） */
export interface BatchPair {
  a: string;
  b: string;
}

/** 批量筛选结果中的一项：与输入下标一一对应，重复候选按原序保留 */
export interface BatchScreenItem {
  /** 输入下标（0 起） */
  index: number;
  a: string;
  b: string;
  /** 试接 (a,b) 可消除的基线脆弱链路（桥）数量；不展开链路清单 */
  removedCount: number;
}

/** 批量筛选整体结果：全批校验通过后一次性生成并整体提交 */
export interface BatchScreenResult {
  /** 按输入下标排列，长度与输入一致 */
  items: BatchScreenItem[];
  /** 生成结果时的基线脆弱链路总数（快照，便于核对） */
  baselineCount: number;
}

/** 试接一条虚拟备纤后的结论 */
export interface TrialResult {
  a: string;
  b: string;
  /** 试接后仍然脆弱的链路（基线桥的子集，按编号 UTF-8 字节序） */
  stillFragile: BridgeInfo[];
  /** 相对基线已消除的链路（按编号 UTF-8 字节序） */
  removed: BridgeInfo[];
  /** 基线脆弱链路总数 */
  baselineCount: number;
}

/** 解析/分析失败时抛出的错误，消息可直接展示给工程师 */
export class TopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TopologyError';
  }
}
