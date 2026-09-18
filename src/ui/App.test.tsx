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
const batchBox = () => screen.getByLabelText('批量方案 JSON 输入') as HTMLTextAreaElement;
const batchButton = () => screen.getByRole('button', { name: '批量筛选' });

/** 读取“脆弱链路总数”统计卡数值（该卡始终随基线渲染，非法导入后也保留） */
const fragileStatValue = () => {
  const label = screen.getByText('脆弱链路总数');
  const card = label.closest('.stat') as HTMLElement;
  return card.querySelector('.stat-value')?.textContent;
};

/** 读取批量结果区指定统计卡数值 */
const batchStatValue = (label: string) => {
  const el = screen.getByText(label);
  const card = el.closest('.stat') as HTMLElement;
  return card.querySelector('.stat-value')?.textContent;
};

/** 当前批量结果表的所有行（下标、端点 A、端点 B、可消除数量） */
const batchRows = () =>
  Array.from(document.querySelectorAll('.batch-table tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => td.textContent),
  );

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

async function submitBatch(text: string) {
  fireEvent.change(batchBox(), { target: { value: text } });
  await waitFor(() => expect(batchBox().value).toBe(text));
  fireEvent.click(batchButton());
}

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
});

describe('批量方案筛选 UI', () => {
  it('合法批次整体替换；末项非法按下标报错并保留上次结果', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    // 合法批次：含重复候选，按输入下标原序显示
    await submitBatch('[{"a":"a","b":"c"},{"a":"a","b":"b"},{"a":"b","b":"c"},{"a":"a","b":"c"}]');
    await waitFor(() => expect(batchStatValue('方案总数')).toBe('4'));
    expect(batchStatValue('基线脆弱链路总数')).toBe('2');
    expect(batchStatValue('可全消方案数')).toBe('2');
    expect(batchRows()).toEqual([
      ['0', 'a', 'c', '2'],
      ['1', 'a', 'b', '1'],
      ['2', 'b', 'c', '1'],
      ['3', 'a', 'c', '2'],
    ]);

    // 末项非法（端点不存在）：按下标报错，上次结果完整保留
    await submitBatch('[{"a":"a","b":"c"},{"a":"a","b":"ghost"}]');
    await waitFor(() => expect(screen.getByText('批量导入被拒绝。')).toBeTruthy());
    expect(screen.getByText(/下标 1/)).toBeTruthy();
    expect(screen.getByText(/不在当前站点清单/)).toBeTruthy();
    expect(batchRows()).toHaveLength(4);

    // 空批次、额外字段同样整体拒绝且保留上次结果
    await submitBatch('[]');
    await waitFor(() => expect(screen.getByText(/空数组/)).toBeTruthy());
    expect(batchRows()).toHaveLength(4);
    await submitBatch('[{"a":"a","b":"c","note":"x"}]');
    await waitFor(() => expect(screen.getByText(/额外字段/)).toBeTruthy());
    expect(batchRows()).toHaveLength(4);

    // 再次合法批次：整体替换旧结果
    await submitBatch('[{"a":"a","b":"b"}]');
    await waitFor(() => expect(batchStatValue('方案总数')).toBe('1'));
    expect(batchRows()).toEqual([['0', 'a', 'b', '1']]);

    // 批量操作不改写单次试接：试接仍正常
    await submitTrial('a', 'c');
    await waitFor(() => expect(screen.getByText(/已消除 2 条/)).toBeTruthy());
    expect(batchStatValue('方案总数')).toBe('1');
  });

  it('合法新拓扑清空批量结果；非法导入保留批量结果', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));
    await submitBatch('[{"a":"a","b":"c"}]');
    await waitFor(() => expect(batchRows()).toHaveLength(1));

    // 合法新拓扑（三角形，无桥）：旧批量结果清空
    await importJson(
      JSON.stringify({
        sites: ['x', 'y', 'z'],
        links: [
          { id: 'r1', u: 'x', v: 'y' },
          { id: 'r2', u: 'y', v: 'z' },
          { id: 'r3', u: 'z', v: 'x' },
        ],
      }),
    );
    await waitFor(() => expect(fragileStatValue()).toBe('0'));
    expect(document.querySelector('.batch-table')).toBeNull();

    // 新拓扑上重新批量筛选（新站点编号）
    await submitBatch('[{"a":"x","b":"z"}]');
    await waitFor(() => expect(batchRows()).toEqual([['0', 'x', 'z', '0']]));

    // 非法导入：保留当前拓扑与批量结果
    await importJson('{坏的');
    await waitFor(() => expect(screen.getByText('导入被拒绝，')).toBeTruthy());
    expect(batchRows()).toEqual([['0', 'x', 'z', '0']]);
  });

  it('批量端点不存在与自环均按下标拒绝', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    await submitBatch('[{"a":"a","b":"a"}]');
    await waitFor(() => expect(screen.getByText(/下标 0.*必须不同/)).toBeTruthy());
    expect(document.querySelector('.batch-table')).toBeNull();

    await submitBatch('[{"a":"a","b":"c"},{"a":"b","b":"c"},{"a":"c","b":"zzz"}]');
    await waitFor(() => expect(screen.getByText(/下标 2/)).toBeTruthy());
    expect(document.querySelector('.batch-table')).toBeNull();
  });

  it('大批量结果按输入下标分页显示', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    // 60 项：超过单页 50 条，触发分页
    const items = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? { a: 'a', b: 'c' } : { a: 'a', b: 'b' }));
    await submitBatch(JSON.stringify(items));
    await waitFor(() => expect(batchStatValue('方案总数')).toBe('60'));

    // 第一页为下标 0–49
    expect(batchRows()).toHaveLength(50);
    expect(batchRows()[0]).toEqual(['0', 'a', 'c', '2']);
    expect(batchRows()[49][0]).toBe('49');

    // 翻到第二页：下标 50–59，计数仍与输入一一对应
    const batchSection = screen.getByText('4. 批量方案筛选').closest('section') as HTMLElement;
    fireEvent.click(within(batchSection).getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(batchRows()).toHaveLength(10));
    expect(batchRows()[0]).toEqual(['50', 'a', 'c', '2']);
    expect(batchRows()[9]).toEqual(['59', 'a', 'b', '1']);
    expect(within(batchSection).getByText(/共 60 条/)).toBeTruthy();
  });
});
