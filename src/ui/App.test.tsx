/// <reference types="vitest/globals" />
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

const validJson = JSON.stringify({
  sites: ['a', 'b', 'c'],
  // 链：a-b 桥（小侧 a=1），b-c 桥（小侧 c=1）
  links: [
    { id: 'L1', u: 'a', v: 'b' },
    { id: 'L2', u: 'b', v: 'c' },
  ],
});

const inputBox = () => screen.getByLabelText('拓扑 JSON 输入') as HTMLTextAreaElement;
const importButton = () => screen.getByRole('button', { name: '导入并分析' });
const trialButton = () => screen.getByRole('button', { name: '试接并核对' });

/** 读取“脆弱链路总数”统计卡数值（该卡始终随基线渲染，非法导入后也保留） */
const fragileStatValue = () => {
  const label = screen.getByText('脆弱链路总数');
  const card = label.closest('.stat') as HTMLElement;
  return card.querySelector('.stat-value')?.textContent;
};

async function importJson(text: string) {
  fireEvent.change(inputBox(), { target: { value: text } });
  // 等待受控输入值提交后再点击，避免同批次事件读到旧输入
  await waitFor(() => expect(inputBox().value).toBe(text));
  fireEvent.click(importButton());
}

async function submitTrial(a: string, b: string) {
  const [inputA, inputB] = screen.getAllByPlaceholderText(/端点/) as HTMLInputElement[];
  fireEvent.change(inputA, { target: { value: a } });
  fireEvent.change(inputB, { target: { value: b } });
  await waitFor(() => {
    expect(inputA.value).toBe(a);
    expect(inputB.value).toBe(b);
  });
  fireEvent.click(trialButton());
}

const batchBox = () => screen.getByLabelText('批量方案 JSON 输入') as HTMLTextAreaElement;
const batchTable = () => screen.getByRole('table', { name: '批量筛选结果' });

async function submitBatch(text: string) {
  fireEvent.change(batchBox(), { target: { value: text } });
  await waitFor(() => expect(batchBox().value).toBe(text));
  fireEvent.click(screen.getByRole('button', { name: '批量筛选' }));
}

/** 批量结果表的数据行（不含表头） */
const batchRows = () => within(batchTable()).getAllByRole('row').slice(1);

afterEach(cleanup);

describe('拓扑工作台 UI', () => {
  it('完整流程：导入 → 基线 → 试接消险 → 非法试接保留上次结果', async () => {
    render(<App />);

    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));
    // 基线列出两条桥
    expect(screen.getByText('L1')).toBeTruthy();
    expect(screen.getByText('L2')).toBeTruthy();

    // 非法导入：损坏 JSON，必须保留上次有效拓扑
    await importJson('{坏的');
    await waitFor(() => expect(screen.getByText('导入被拒绝，')).toBeTruthy());
    // 基线区仍在（脆弱链路总数统计卡仍为 2）
    expect(fragileStatValue()).toBe('2');
    expect(screen.getByText('L1')).toBeTruthy();

    // 合法试接 a-c：跨越两座桥，全部消除
    await submitTrial('a', 'c');
    await waitFor(() => expect(screen.getByText(/已消除 2 条/)).toBeTruthy());
    expect(screen.getByText(/试接后原基线脆弱链路已全部消除/)).toBeTruthy();

    // 非法试接：端点不存在；上次试接结果必须保留，并显示明确错误
    await submitTrial('a', 'ghost');
    await waitFor(() => expect(screen.getByText('试接被拒绝。')).toBeTruthy());
    expect(screen.getByText(/已消除 2 条/)).toBeTruthy();
    expect(screen.getByText(/不在当前站点清单/)).toBeTruthy();

    // 相同端点也被拒绝
    await submitTrial('b', 'b');
    await waitFor(() => expect(screen.getByText(/两个端点必须不同/)).toBeTruthy());
    // 上次成功结果仍保留
    expect(screen.getByText(/已消除 2 条/)).toBeTruthy();
  });

  it('部分消险：试接平行于一座桥只消除该桥', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    await submitTrial('b', 'c');
    await waitFor(() => expect(screen.getByText(/仍脆弱 1 条/)).toBeTruthy());
    expect(screen.getByText(/已消除 1 条/)).toBeTruthy();

    // 仍脆弱区为 L1，已消除区为 L2
    const stillBlock = screen.getByText(/仍脆弱的链路/).closest('section') ?? document.body;
    expect(stillBlock.textContent).toContain('L1');
    const removedBlock = screen.getByText(/相对基线已消除/).closest('section') ?? document.body;
    expect(removedBlock.textContent).toContain('L2');
  });

  it('非连通 / 自环等非法导入均被拒绝且保留上次基线', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    await importJson(
      JSON.stringify({
        sites: ['a', 'b', 'c', 'd'],
        links: [
          { id: 'x', u: 'a', v: 'b' },
          { id: 'y', u: 'c', v: 'd' },
        ],
      }),
    );
    await waitFor(() => expect(screen.getByText(/原图必须连通/)).toBeTruthy());

    await importJson(
      JSON.stringify({
        sites: ['a', 'b'],
        links: [{ id: 'z', u: 'a', v: 'a' }],
      }),
    );
    await waitFor(() => expect(screen.getByText(/自环非法/)).toBeTruthy());

    // 旧基线依旧保留（脆弱链路总数统计卡仍为 2，桥行仍在）
    expect(fragileStatValue()).toBe('2');
    expect(screen.getByText('L2')).toBeTruthy();
  });

  it('批量方案筛选：成功整体替换、末项非法无部分结果、新拓扑清空', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    // 合法批量：a-c 消除 2 座桥，b-c 消除 1 座，重复候选按原序保留
    await submitBatch(JSON.stringify([{ a: 'a', b: 'c' }, { a: 'b', b: 'c' }, { a: 'a', b: 'c' }]));
    await waitFor(() => expect(screen.getByText('候选方案数')).toBeTruthy());
    let rows = batchRows();
    expect(rows).toHaveLength(3);
    const cellsOf = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent);
    expect(cellsOf(rows[0])).toEqual(['0', 'a', 'c', '2']);
    expect(cellsOf(rows[1])).toEqual(['1', 'b', 'c', '1']);
    expect(cellsOf(rows[2])).toEqual(['2', 'a', 'c', '2']);

    // 末项非法：按下标报错、无部分结果，上次批量结果保留
    await submitBatch(JSON.stringify([{ a: 'a', b: 'c' }, { a: 'a', b: 'ghost' }]));
    await waitFor(() => expect(screen.getByText('批量筛选被拒绝。')).toBeTruthy());
    expect(screen.getByText(/下标 1/)).toBeTruthy();
    expect(screen.getByText(/不在当前站点清单/)).toBeTruthy();
    expect(batchRows()).toHaveLength(3);
    expect(cellsOf(batchRows()[0])).toEqual(['0', 'a', 'c', '2']);
    // 基线与单次试接结果不受影响
    expect(fragileStatValue()).toBe('2');

    // 额外字段 / 空批次 / 相同端点均整体拒绝
    await submitBatch(JSON.stringify([{ a: 'a', b: 'c', note: 1 }]));
    await waitFor(() => expect(screen.getByText(/额外字段/)).toBeTruthy());
    expect(batchRows()).toHaveLength(3);
    await submitBatch('[]');
    await waitFor(() => expect(screen.getByText(/不能为空数组/)).toBeTruthy());
    await submitBatch(JSON.stringify([{ a: 'b', b: 'b' }]));
    await waitFor(() => expect(screen.getByText(/必须不同/)).toBeTruthy());
    expect(batchRows()).toHaveLength(3);

    // 非法导入：保留上次有效拓扑与批量结果
    await importJson('{坏的');
    await waitFor(() => expect(screen.getByText('导入被拒绝，')).toBeTruthy());
    expect(batchRows()).toHaveLength(3);

    // 合法新拓扑：清空旧批量结果（基线随之更新）
    await importJson(
      JSON.stringify({
        sites: ['x', 'y'],
        links: [{ id: 'R1', u: 'x', v: 'y' }],
      }),
    );
    await waitFor(() => expect(fragileStatValue()).toBe('1'));
    expect(screen.queryByText('候选方案数')).toBeNull();
    expect(screen.queryByRole('table', { name: '批量筛选结果' })).toBeNull();

    // 新拓扑下可重新批量筛选（单次试接明细保持兼容）
    await submitBatch(JSON.stringify([{ a: 'x', b: 'y' }]));
    await waitFor(() => expect(screen.getByText('候选方案数')).toBeTruthy());
    rows = batchRows();
    expect(rows).toHaveLength(1);
    expect(cellsOf(rows[0])).toEqual(['0', 'x', 'y', '1']);
    await submitTrial('x', 'y');
    await waitFor(() => expect(screen.getByText(/已消除 1 条/)).toBeTruthy());
  });
});
