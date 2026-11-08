import { describe, expect, it } from 'vitest';
import { CHAT_PANEL_DEFAULTS, chatPanelView } from '@core/chat/panelState';

const some = { n: 12_843 };
const none = { n: 0 };

describe('chatPanelView with default options', () => {
  // These are the strings and rules ChatPanel had before it became configurable.
  // The current dashboard chatbot must behave exactly as it did.
  it('keeps the original wording', () => {
    expect(CHAT_PANEL_DEFAULTS.title).toBe('Ask about the selection');
    expect(CHAT_PANEL_DEFAULTS.placeholder).toBe('Ask about these cells…');
    expect(CHAT_PANEL_DEFAULTS.placeholderNoSelection).toBe('Select cells first, then ask a question…');
    expect(CHAT_PANEL_DEFAULTS.requireSelection).toBe(true);
  });

  it('starts locked with no selection', () => {
    const v = chatPanelView({}, null, false);
    expect(v.title).toBe('Ask about the selection');
    expect(v.inputDisabled).toBe(true);
    expect(v.sendDisabled).toBe(true);
    expect(v.placeholder).toBe('Select cells first, then ask a question…');
    expect(v.badge).toBe('no selection');
  });

  it('treats an empty selection as no selection', () => {
    expect(chatPanelView({}, none, false)).toEqual(chatPanelView({}, null, false));
  });

  it('unlocks when cells are selected and shows how many', () => {
    const v = chatPanelView({}, some, false);
    expect(v.inputDisabled).toBe(false);
    expect(v.sendDisabled).toBe(false);
    expect(v.placeholder).toBe('Ask about these cells…');
    expect(v.badge).toBe(`${(12_843).toLocaleString()} cells`);
  });

  it('keeps Ask disabled while an answer is still streaming, but leaves the input usable', () => {
    const v = chatPanelView({}, some, true);
    expect(v.sendDisabled).toBe(true);
    expect(v.inputDisabled).toBe(false);
  });

  it('stays locked while busy with no selection', () => {
    const v = chatPanelView({}, null, true);
    expect(v.inputDisabled).toBe(true);
    expect(v.sendDisabled).toBe(true);
  });

  it('equals the explicit defaults', () => {
    for (const ctx of [null, none, some]) {
      for (const busy of [false, true]) {
        expect(chatPanelView({}, ctx, busy)).toEqual(chatPanelView({ ...CHAT_PANEL_DEFAULTS }, ctx, busy));
      }
    }
  });
});

describe('chatPanelView with options', () => {
  it('takes a title and placeholders', () => {
    const opts = { title: 'Recipe maker', placeholder: 'Ask for a recipe…', placeholderNoSelection: 'Pick cells…' };
    expect(chatPanelView(opts, null, false).title).toBe('Recipe maker');
    expect(chatPanelView(opts, null, false).placeholder).toBe('Pick cells…');
    expect(chatPanelView(opts, some, false).placeholder).toBe('Ask for a recipe…');
  });

  it('keeps the default for an option that is left out', () => {
    const v = chatPanelView({ title: 'Only the title' }, some, false);
    expect(v.placeholder).toBe('Ask about these cells…');
  });

  describe('when a selection is not required', () => {
    const opts = { requireSelection: false, title: 'Recipe maker', placeholder: 'Ask for a recipe…' };

    it('is usable with no selection, with the ready placeholder', () => {
      for (const ctx of [null, none]) {
        const v = chatPanelView(opts, ctx, false);
        expect(v.inputDisabled).toBe(false);
        expect(v.sendDisabled).toBe(false);
        expect(v.placeholder).toBe('Ask for a recipe…');
      }
    });

    it('still disables Ask while an answer is in flight', () => {
      expect(chatPanelView(opts, null, true).sendDisabled).toBe(true);
      expect(chatPanelView(opts, null, true).inputDisabled).toBe(false);
    });

    it('has no selection badge, because the selection plays no part', () => {
      expect(chatPanelView(opts, null, false).badge).toBeNull();
      expect(chatPanelView(opts, some, false).badge).toBeNull();
    });
  });
});
