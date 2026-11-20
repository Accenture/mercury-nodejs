import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Card } from './Card';
import { row } from '../test/fixtures';
import type { Decision } from '../types';

describe('Card', () => {
  it('asks for every waiting call before it sends', async () => {
    const onDecide = vi.fn(async () => {});
    const { container } = render(<Card row={row({ id: 1, seq: 1 })} onDecide={onDecide} />);
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Approve or refuse every waiting call');
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('collects an approval with its note and the answer picked for a question', async () => {
    let sent: Decision[] | null = null;
    const onDecide = vi.fn(async (_row, decisions: Decision[]) => {
      sent = decisions;
    });
    const { container } = render(<Card row={row({ id: 1, seq: 1 })} onDecide={onDecide} />);
    fireEvent.click(container.querySelector('input[name="d-0"][value="yes"]')!);
    fireEvent.change(container.querySelector('fieldset[data-id="toolu_01A"] input[type=text]')!, { target: { value: 'go ahead' } });
    fireEvent.click(container.querySelector('input[name="a-1"][value="no"]')!);
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1));
    expect(sent).toEqual([{ id: 'toolu_01A', approved: true, note: 'go ahead' }, { id: 'toolu_01B', answer: 'no' }]);
  });

  it('takes a typed answer when the person picks another answer', async () => {
    let sent: Decision[] | null = null;
    const { container } = render(<Card row={row({ id: 1, seq: 1, calls: [{ id: 'q1', ask: true, input: { options: ['a', 'b'] } }] })} onDecide={async (_r, d) => { sent = d; }} />);
    fireEvent.click(container.querySelector('input[name="a-0"][value="__other__"]')!);
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'something else' } });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => expect(sent).toEqual([{ id: 'q1', answer: 'something else' }]));
  });

  it('shows the problem when the decision fails', async () => {
    const { container } = render(<Card row={row({ id: 1, seq: 1, calls: [CALL_WRITE] })} onDecide={async () => { throw new Error('nothing waiting'); }} />);
    fireEvent.click(container.querySelector('input[value="no"]')!);
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing waiting');
  });

  it('shows who decided a closed wait and no form', () => {
    const { container } = render(<Card row={row({ id: 2, seq: 4, state: 'answered', answered_by: 'operator-1', answered_at: '2026-11-20T08:10:00.000Z', outcome: { status: 200, body: { type: 'resumed' } } })} />);
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).toContain('decided by operator-1');
    expect(container.textContent).toContain('resumed');
  });

  it('shows an advice as a notice', () => {
    const { container } = render(<Card row={row({ id: 3, seq: 5, kind: 'advice', state: null, ticket: null, link: null, calls: null, summary: 'Resumed after the decision' })} />);
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('.card.advice')).not.toBeNull();
    expect(container.textContent).toContain('Resumed after the decision');
  });
});

const CALL_WRITE = { id: 'toolu_01A', name: 'graph.task.write', wait: true, input: { order: 'o-7' } };
