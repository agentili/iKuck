import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ShoppingListItem, ShoppingListItemPayload } from '@ikuck/shared/contracts';
import ShoppingListPanel from './ShoppingListPanel';

const item = (overrides: Partial<ShoppingListItem> = {}): ShoppingListItem => ({
  id: 'shopping-pasta',
  ingredientId: 'pasta',
  label: 'Pasta',
  quantity: null,
  unit: null,
  note: null,
  purchased: false,
  sourceRecipeId: null,
  createdAt: '2026-09-13T10:00:00.000Z',
  updatedAt: '2026-09-13T10:00:00.000Z',
  ...overrides,
});

const renderPanel = (items: ShoppingListItem[] = [], overrides: Partial<{
  onAdd: (input: ShoppingListItemPayload) => string | null;
  onTogglePurchased: (id: string) => boolean;
  onRemove: (id: string) => void;
  onRestoreItem: (item: ShoppingListItem) => boolean;
  onUpdate: (id: string, patch: { label?: string; quantity?: number | null; unit?: ShoppingListItem['unit']; note?: string | null }) => boolean;
  onClearPurchased: () => number;
}> = {}) => render(
  <ShoppingListPanel
    items={items}
    onAdd={overrides.onAdd ?? vi.fn().mockReturnValue('shopping-new')}
    onTogglePurchased={overrides.onTogglePurchased ?? vi.fn().mockReturnValue(true)}
    onRemove={overrides.onRemove ?? vi.fn()}
    onRestoreItem={overrides.onRestoreItem ?? vi.fn().mockReturnValue(true)}
    onUpdate={overrides.onUpdate ?? vi.fn().mockReturnValue(true)}
    onClearPurchased={overrides.onClearPurchased ?? vi.fn().mockReturnValue(1)}
  />,
);

describe('ShoppingListPanel', () => {
  it('adds a manual item with optional quantity and unit', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockReturnValue('shopping-new');
    renderPanel([], { onAdd });

    await user.type(screen.getByLabelText('Cosa ti serve?'), 'Pasta');
    await user.click(screen.getByText('Aggiungi dettagli (facoltativi)'));
    await user.type(screen.getByLabelText('Quantità da acquistare'), '500');
    await user.selectOptions(screen.getByLabelText('Unità di misura della spesa'), 'g');
    await user.click(screen.getByRole('button', { name: 'Aggiungi alla lista' }));

    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({
      ingredientId: 'pasta',
      label: 'Pasta',
      quantity: 500,
      unit: 'g',
      purchased: false,
      sourceRecipeId: null,
    }));
  });

  it('shows validation feedback when quantity has no unit', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    renderPanel([], { onAdd });

    await user.type(screen.getByLabelText('Cosa ti serve?'), 'Pasta');
    await user.click(screen.getByText('Aggiungi dettagli (facoltativi)'));
    await user.type(screen.getByLabelText('Quantità da acquistare'), '500');
    await user.click(screen.getByRole('button', { name: 'Aggiungi alla lista' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Se indichi una quantità, scegli anche l’unità.');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('toggles purchased state, removes an item and clears purchased entries', async () => {
    const user = userEvent.setup();
    const onTogglePurchased = vi.fn().mockReturnValue(true);
    const onRemove = vi.fn();
    const onClearPurchased = vi.fn().mockReturnValue(1);
    renderPanel([item({ purchased: true }), item({ id: 'shopping-tomato', label: 'Pomodori' })], { onTogglePurchased, onRemove, onClearPurchased });

    await user.click(screen.getByRole('button', { name: 'Segna Pasta come da acquistare' }));
    await user.click(screen.getByRole('button', { name: 'Rimuovi Pomodori' }));
    await user.click(screen.getByRole('button', { name: 'Rimuovi gli acquistati' }));

    expect(onTogglePurchased).toHaveBeenCalledWith('shopping-pasta');
    expect(onRemove).toHaveBeenCalledWith('shopping-tomato');
    expect(onClearPurchased).toHaveBeenCalledOnce();
  });

  it('explains an empty list and shows recipe source metadata', () => {
    const { rerender } = renderPanel();
    expect(screen.getByText('La lista è vuota')).toBeVisible();

    rerender(
      <ShoppingListPanel
        items={[item({ sourceRecipeId: 'pasta-tonno-pomodoro', note: 'q.b.' })]}
        onAdd={vi.fn().mockReturnValue('new')}
        onTogglePurchased={vi.fn().mockReturnValue(true)}
        onRemove={vi.fn()}
        onUpdate={vi.fn().mockReturnValue(true)}
        onClearPurchased={vi.fn().mockReturnValue(0)}
      />,
    );
    expect(screen.getByText(/Dalla ricetta: Pasta tonno e pomodoro/)).toBeVisible();
    expect(screen.getByText(/Nota: q\.b\./)).toBeVisible();
  });

  it('restores a removed item from the undo toast', async () => {
    const user = userEvent.setup();
    const onRestoreItem = vi.fn().mockReturnValue(true);
    renderPanel([item()], { onRestoreItem });

    await user.click(screen.getByRole('button', { name: 'Rimuovi Pasta' }));
    await user.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(onRestoreItem).toHaveBeenCalledWith(item());
  });

  it('shows the pending-item count chip in the header', () => {
    renderPanel([
      item(),
      item({ id: 'shopping-tomato', label: 'Pomodori' }),
      item({ id: 'shopping-pane', label: 'Pane', purchased: true }),
    ]);

    expect(screen.getByText('2 da acquistare')).toBeInTheDocument();
    expect(screen.queryByText('1 da acquistare')).not.toBeInTheDocument();
  });

  it('shows and hides the purchased section through its toggle', async () => {
    const user = userEvent.setup();
    renderPanel([
      item({ id: 'shopping-pasta', label: 'Pasta', purchased: true }),
      item({ id: 'shopping-tomato', label: 'Pomodori' }),
    ]);

    expect(screen.getByRole('heading', { name: /Acquistati/ })).toBeInTheDocument();
    expect(screen.getByText('Pasta')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Nascondi acquistati' }));
    expect(screen.getByRole('button', { name: 'Mostra acquistati' })).toBeInTheDocument();
    expect(screen.queryByText('Pasta')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mostra acquistati' }));
    expect(screen.getByText('Pasta')).toBeInTheDocument();
  });

  it('opens the item editor only on click of Modifica and saves changes', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockReturnValue(true);
    renderPanel([item({ label: 'Pasta' })], { onUpdate });

    expect(screen.queryByLabelText('Nome')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Modifica Pasta' }));
    await user.clear(screen.getByLabelText('Nome'));
    await user.type(screen.getByLabelText('Nome'), 'Penne');
    await user.click(screen.getByRole('button', { name: 'Salva dettagli' }));

    expect(onUpdate).toHaveBeenCalledWith('shopping-pasta', expect.objectContaining({ label: 'Penne' }));
  });

  it('exposes a clearly named entry workbench before the pending list', () => {
    renderPanel([item()]);
    const entry = screen.getByRole('form', { name: 'Aggiungi un prodotto' });
    const pending = screen.getByRole('region', { name: /Da acquistare/ });
    expect(within(entry).getByRole('textbox', { name: 'Cosa ti serve?' })).toBeVisible();
    expect(entry.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps focus on undo during partial restore and retries only failed items', async () => {
    const user = userEvent.setup();
    const pasta = item({ purchased: true });
    const pane = item({ id: 'shopping-pane', label: 'Pane', purchased: true });
    const onRestoreItem = vi.fn();
    let paneFailed = false;
    function ShoppingHarness() {
      const [items, setItems] = useState([pasta, pane]);
      return <ShoppingListPanel
        items={items}
        onAdd={() => null}
        onTogglePurchased={() => false}
        onRemove={() => undefined}
        onRestoreItem={(restored) => {
          onRestoreItem(restored);
          if (restored.id === pane.id && !paneFailed) {
            paneFailed = true;
            return false;
          }
          setItems((current) => [...current, restored]);
          return true;
        }}
        onUpdate={() => false}
        onClearPurchased={() => {
          setItems((current) => current.filter((entry) => !entry.purchased));
          return 2;
        }}
      />;
    }
    render(<ShoppingHarness />);

    const clear = screen.getByRole('button', { name: 'Rimuovi gli acquistati' });
    clear.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Annulla' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Segna Pasta come da acquistare' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Segna Pane come da acquistare' })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onRestoreItem.mock.calls.map(([restored]) => restored.id)).toEqual([pasta.id, pane.id, pane.id]);
    expect(screen.queryByRole('button', { name: 'Annulla' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Segna Pane come da acquistare' })).toHaveFocus();
  });

  it('keeps focus on undo when a restoration fails completely', async () => {
    const user = userEvent.setup();
    const purchased = item({ purchased: true });
    let attempt = 0;
    function ShoppingHarness() {
      const [items, setItems] = useState([purchased]);
      return <ShoppingListPanel
        items={items}
        onAdd={() => null}
        onTogglePurchased={() => false}
        onRemove={() => undefined}
        onRestoreItem={(restored) => {
          attempt += 1;
          if (attempt === 1) return false;
          setItems((current) => [...current, restored]);
          return true;
        }}
        onUpdate={() => false}
        onClearPurchased={() => {
          setItems([]);
          return 1;
        }}
      />;
    }
    render(<ShoppingHarness />);

    const clear = screen.getByRole('button', { name: 'Rimuovi gli acquistati' });
    clear.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Annulla' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Segna Pasta come da acquistare' })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(attempt).toBe(2);
    expect(screen.getByRole('button', { name: 'Segna Pasta come da acquistare' })).toHaveFocus();
  });

  it('keeps the clear action with purchased items, after pending items', () => {
    renderPanel([item({ purchased: true }), item({ id: 'shopping-pane', label: 'Pane' })]);

    const pending = screen.getByRole('region', { name: /Da acquistare/ });
    const purchased = screen.getByRole('region', { name: /Acquistati/ });
    expect(within(pending).getByText('Pane')).toBeVisible();
    expect(within(purchased).getByText('Pasta')).toBeVisible();
    expect(within(purchased).getByRole('button', { name: 'Rimuovi gli acquistati' })).toBeVisible();
    expect(pending.compareDocumentPosition(purchased) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('focuses the editor and returns focus to the row after cancelling', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockReturnValue(true);
    renderPanel([item()], { onUpdate });

    await user.click(screen.getByRole('button', { name: 'Modifica Pasta' }));
    expect(screen.getByRole('textbox', { name: 'Nome' })).toHaveFocus();
    await user.clear(screen.getByRole('textbox', { name: 'Nome' }));
    await user.type(screen.getByRole('textbox', { name: 'Nome' }), 'Penne');
    await user.click(screen.getByRole('button', { name: 'Annulla modifiche' }));
    expect(screen.queryByRole('textbox', { name: 'Nome' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Modifica Pasta' })).toHaveFocus();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('keeps an actionable pending area when everything is purchased', () => {
    renderPanel([item({ purchased: true })]);

    const pending = screen.getByRole('region', { name: /Da acquistare/ });
    expect(within(pending).getByText('Tutto acquistato')).toBeVisible();
    expect(within(pending).getByText(/Puoi aggiungere/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Aggiungi alla lista' })).toBeVisible();
  });

  it('focuses undo after a keyboard removal', async () => {
    const user = userEvent.setup();
    function ShoppingHarness() {
      const [items, setItems] = useState([item()]);
      return <ShoppingListPanel
        items={items}
        onAdd={() => null}
        onTogglePurchased={() => false}
        onRemove={(id) => setItems((current) => current.filter((entry) => entry.id !== id))}
        onRestoreItem={() => true}
        onUpdate={() => false}
        onClearPurchased={() => 0}
      />;
    }
    render(<ShoppingHarness />);
    const remove = screen.getByRole('button', { name: 'Rimuovi Pasta' });
    remove.focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: 'Rimuovi Pasta' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Annulla' })).toHaveFocus();
  });

  it('focuses the visible purchased disclosure after keyboard undo while purchased stays collapsed', async () => {
    const user = userEvent.setup();
    const purchased = item({ id: 'shopping-uova', ingredientId: 'uova', label: 'Uova', quantity: 6, unit: 'piece', purchased: true });
    const onRestoreItem = vi.fn();
    function ShoppingHarness() {
      const [items, setItems] = useState([purchased, item({ id: 'shopping-pane', label: 'Pane' })]);
      return <ShoppingListPanel
        items={items}
        onAdd={() => null}
        onTogglePurchased={() => false}
        onRemove={() => undefined}
        onRestoreItem={(restored) => {
          onRestoreItem(restored);
          setItems((current) => [...current, restored]);
          return true;
        }}
        onUpdate={() => false}
        onClearPurchased={() => {
          setItems((current) => current.filter((entry) => !entry.purchased));
          return 1;
        }}
      />;
    }
    render(<ShoppingHarness />);

    await user.click(screen.getByRole('button', { name: 'Nascondi acquistati' }));
    const clear = screen.getByRole('button', { name: 'Rimuovi gli acquistati' });
    clear.focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: 'Mostra acquistati' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Annulla' })).toHaveFocus();
    await user.keyboard('{Enter}');

    const disclosure = screen.getByRole('button', { name: 'Mostra acquistati' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(disclosure).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Segna Uova come da acquistare' })).not.toBeInTheDocument();
    expect(onRestoreItem).toHaveBeenCalledOnce();
    expect(onRestoreItem.mock.calls[0][0]).toBe(purchased);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Segna Uova come da acquistare' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: /Acquistati/ })).getByText('6 pezzi')).toBeVisible();
  });

  it('returns focus to a restored row after undo', async () => {
    const user = userEvent.setup();
    function ShoppingHarness() {
      const [items, setItems] = useState([item()]);
      return <ShoppingListPanel
        items={items}
        onAdd={() => null}
        onTogglePurchased={() => false}
        onRemove={(id) => setItems((current) => current.filter((entry) => entry.id !== id))}
        onRestoreItem={(restored) => {
          setItems((current) => [...current, restored]);
          return true;
        }}
        onUpdate={() => false}
        onClearPurchased={() => 0}
      />;
    }
    render(<ShoppingHarness />);
    const remove = screen.getByRole('button', { name: 'Rimuovi Pasta' });
    remove.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Segna Pasta come acquistato' })).toHaveFocus();
  });

  it('keeps focus on the purchased disclosure when a checked item moves into a hidden section', async () => {
    const user = userEvent.setup();
    function ShoppingHarness() {
      const [items, setItems] = useState([item(), item({ id: 'shopping-pane', label: 'Pane', purchased: true })]);
      return <ShoppingListPanel
        items={items}
        onAdd={() => null}
        onTogglePurchased={(id) => {
          setItems((current) => current.map((entry) => entry.id === id ? { ...entry, purchased: !entry.purchased } : entry));
          return true;
        }}
        onRemove={() => undefined}
        onUpdate={() => false}
        onClearPurchased={() => 0}
      />;
    }
    render(<ShoppingHarness />);
    await user.click(screen.getByRole('button', { name: 'Nascondi acquistati' }));
    const toggle = screen.getByRole('button', { name: 'Segna Pasta come acquistato' });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Mostra acquistati' })).toHaveFocus();
    expect(screen.getByRole('status', { name: 'Stato della lista' })).toHaveTextContent('Acquistato: Pasta.');
  });

  it('keeps keyboard focus and announces the change when an item moves to purchased', async () => {
    const user = userEvent.setup();
    function ShoppingHarness() {
      const [items, setItems] = useState([item()]);
      return <ShoppingListPanel
        items={items}
        onAdd={() => null}
        onTogglePurchased={(id) => {
          setItems((current) => current.map((entry) => entry.id === id ? { ...entry, purchased: !entry.purchased } : entry));
          return true;
        }}
        onRemove={() => undefined}
        onUpdate={() => false}
        onClearPurchased={() => 0}
      />;
    }
    render(<ShoppingHarness />);

    await user.tab();
    // The row can be activated with a keyboard once it has focus.
    const toggle = screen.getByRole('button', { name: 'Segna Pasta come acquistato' });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Segna Pasta come da acquistare' })).toHaveFocus();
    expect(screen.getByRole('status', { name: 'Stato della lista' })).toHaveTextContent('Acquistato: Pasta.');
  });

  describe('ShoppingListPanel — conteggio "X da acquistare" in header', () => {
    it('mostra il conteggio degli elementi da acquistare', () => {
      renderPanel([
        item(),
        item({ id: 'shopping-tomato', label: 'Pomodori', purchased: true }),
        item({ id: 'shopping-latte', label: 'Latte' }),
      ]);
      expect(screen.getByText('2 da acquistare')).toBeInTheDocument();
    });

    it('usa la forma singolare con un solo elemento da acquistare', () => {
      renderPanel([item()]);
      expect(screen.getByText('1 da acquistare')).toBeInTheDocument();
    });

    it('mostra "0 da acquistare" quando la lista è vuota', () => {
      renderPanel([]);
      expect(screen.getByText('0 da acquistare')).toBeInTheDocument();
    });
  });

  describe('ShoppingListPanel — sezione "Acquistati" toggle mostra/nascondi', () => {
    it('apre la sezione acquistati con il toggle "Nascondi acquistati" per default', () => {
      renderPanel([item({ purchased: true }), item({ id: 'shopping-tomato', label: 'Pomodori' })]);

      expect(screen.getByRole('button', { name: 'Nascondi acquistati' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Nascondi acquistati' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('heading', { name: /Acquistati/ })).toBeInTheDocument();
    });

    it('nasconde e mostra la sezione acquistati al click sul toggle', async () => {
      const user = userEvent.setup();
      renderPanel([item({ purchased: true })]);
      const heading = screen.getByRole('heading', { name: /Acquistati/ });
      expect(heading).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Nascondi acquistati' }));
      expect(screen.getByRole('button', { name: 'Mostra acquistati' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Pasta')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Mostra acquistati' }));
      expect(screen.getByRole('button', { name: 'Nascondi acquistati' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('Pasta')).toBeInTheDocument();
    });
  });

  describe('ShoppingListPanel — editor dettagli aperto al click su "Modifica"', () => {
    it('apre l\'editor solo per la riga su cui si clicca "Modifica"', async () => {
      const user = userEvent.setup();
      renderPanel([item(), item({ id: 'shopping-tomato', label: 'Pomodori' })]);

      expect(screen.queryByLabelText('Nome')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Modifica Pasta' }));

      expect(screen.getByLabelText('Nome')).toBeInTheDocument();
      expect(screen.getByLabelText('Quantità', { exact: true })).toBeInTheDocument();
      expect(screen.getByLabelText('Unità', { exact: true })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Salva dettagli' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Modifica Pomodori' }));

      expect(screen.getByLabelText('Nome')).toHaveValue('Pomodori');
      expect(screen.getByRole('button', { name: 'Salva dettagli' })).toBeInTheDocument();
    });

    it('salva quantità e unità tramite onUpdate', async () => {
      const onUpdate = vi.fn().mockReturnValue(true);
      renderPanel([item()], { onUpdate });
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: 'Modifica Pasta' }));
      await user.type(screen.getByLabelText('Quantità', { exact: true }), '1');
      await user.selectOptions(screen.getByLabelText('Unità', { exact: true }), 'kg');
      await user.click(screen.getByRole('button', { name: 'Salva dettagli' }));

      expect(onUpdate).toHaveBeenCalledWith('shopping-pasta', {
        label: 'Pasta',
        quantity: 1,
        unit: 'kg',
        note: null,
      });
    });

    it('non salva e mostra l\'errore di validazione quando il nome è vuoto', async () => {
      const onUpdate = vi.fn().mockReturnValue(true);
      renderPanel([item()], { onUpdate });
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: 'Modifica Pasta' }));
      await user.clear(screen.getByLabelText('Nome'));
      await user.click(screen.getByRole('button', { name: 'Salva dettagli' }));

      expect(onUpdate).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Scrivi cosa vuoi aggiungere alla lista.');
    });
  });

  describe('ShoppingListPanel — stato vuoto illustrato', () => {
    it('mostra lo stato vuoto con illustrazione quando non ci sono elementi', () => {
      renderPanel([]);

      expect(screen.getByText('La lista è vuota')).toBeInTheDocument();
      expect(screen.getByText('🛒')).toBeInTheDocument();
      expect(screen.getByText('Aggiungi il primo prodotto dalla barra sopra.')).toBeInTheDocument();
    });
  });

  describe('ShoppingListPanel — barra azioni degli acquistati', () => {
    it('mostra "Rimuovi gli acquistati" solo quando ci sono elementi acquistati', () => {
      renderPanel([item({ purchased: true })]);
      expect(screen.getByRole('button', { name: 'Rimuovi gli acquistati' })).toBeInTheDocument();
    });

    it('non mostra la barra azioni quando non ci sono elementi acquistati', () => {
      renderPanel([item()]);
      expect(screen.queryByRole('button', { name: 'Rimuovi gli acquistati' })).not.toBeInTheDocument();
    });
  });

  describe('ShoppingListPanel — chiarezza tasti azione e stati acquistati', () => {
    it('espone l\'etichetta visibile "Modifica" sul tasto azione di ogni riga', async () => {
      const user = userEvent.setup();
      renderPanel([item(), item({ id: 'shopping-tomato', label: 'Pomodori' })]);

      expect(screen.getAllByText('Modifica')).toHaveLength(2);

      const modificaPasta = screen.getByRole('button', { name: 'Modifica Pasta' });
      await expect(modificaPasta).toHaveTextContent('Modifica');

      await user.click(modificaPasta);
      expect(screen.getByLabelText('Nome')).toBeInTheDocument();
    });

    it('espone l\'etichetta visibile "Rimuovi" sul tasto azione di ogni riga', () => {
      renderPanel([item(), item({ id: 'shopping-tomato', label: 'Pomodori' })]);

      expect(screen.getAllByText('Rimuovi')).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Rimuovi Pomodori' })).toHaveTextContent('Rimuovi');
    });

    it('marca le righe acquistate con lo stato "purchased" e le altre con "pending"', () => {
      renderPanel([
        item({ id: 'shopping-pasta', label: 'Pasta', purchased: true }),
        item({ id: 'shopping-tomato', label: 'Pomodori' }),
      ]);

      const pastaRow = screen.getByText('Pasta', { exact: true }).closest('li') as HTMLLIElement;
      expect(pastaRow).toHaveAttribute('data-state', 'purchased');
      expect(pastaRow.querySelector('[aria-pressed="true"]')).toBeInTheDocument();

      const tomatoRow = screen.getByText('Pomodori', { exact: true }).closest('li') as HTMLLIElement;
      expect(tomatoRow).toHaveAttribute('data-state', 'pending');
      expect(tomatoRow.querySelector('[aria-pressed="true"]')).not.toBeInTheDocument();
    });
  });
});
