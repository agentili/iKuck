import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UndoToast from './UndoToast';

describe('UndoToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces the deletion and lets the user undo it', () => {
    const onUndo = vi.fn();
    const onExpire = vi.fn();

    render(<UndoToast message="Lotto rimosso." onUndo={onUndo} onExpire={onExpire} />);

    expect(screen.getByRole('status')).toHaveTextContent('Lotto rimosso.');
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(onUndo).toHaveBeenCalledOnce();
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('expires automatically after the undo window', () => {
    const onExpire = vi.fn();
    render(<UndoToast message="Elemento rimosso." onUndo={vi.fn()} onExpire={onExpire} durationMs={5000} />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(onExpire).toHaveBeenCalledOnce();
  });
});
