import type { SelectionContext } from '../context/build';

/** How a chat panel presents itself. Every field is optional; see `CHAT_PANEL_DEFAULTS`. */
export interface ChatPanelOptions {
  title?: string;
  /** Shown when the input is usable. */
  placeholder?: string;
  /** Shown while a selection is required and there is none. */
  placeholderNoSelection?: string;
  /** Whether asking needs selected cells. The selection chat does; a general chatbot does not. */
  requireSelection?: boolean;
}

/** The wording and rule the dashboard chat had before the panel was configurable. */
export const CHAT_PANEL_DEFAULTS: Required<ChatPanelOptions> = {
  title: 'Ask about the selection',
  placeholder: 'Ask about these cells…',
  placeholderNoSelection: 'Select cells first, then ask a question…',
  requireSelection: true
};

export interface ChatPanelView {
  title: string;
  inputDisabled: boolean;
  sendDisabled: boolean;
  placeholder: string;
  /** Text for the badge in the header, or null to hide it. */
  badge: string | null;
}

/**
 * What the panel should look like for a selection and a busy flag.
 *
 * Kept out of the DOM class so the rules can be tested in plain Node. With the
 * default options this reproduces the panel's original behaviour exactly:
 * input and Ask are locked until cells are selected, a new selection must not
 * re-enable Ask while an answer is still streaming, and the badge counts cells.
 */
export function chatPanelView(
  options: ChatPanelOptions,
  ctx: Pick<SelectionContext, 'n'> | null,
  busy: boolean
): ChatPanelView {
  const o = { ...CHAT_PANEL_DEFAULTS, ...stripUndefined(options) };
  const has = !!ctx && ctx.n > 0;
  const usable = o.requireSelection ? has : true;
  return {
    title: o.title,
    inputDisabled: !usable,
    sendDisabled: !usable || busy,
    placeholder: usable ? o.placeholder : o.placeholderNoSelection,
    badge: o.requireSelection ? (has ? `${ctx!.n.toLocaleString()} cells` : 'no selection') : null
  };
}

/** An option passed as `undefined` means "use the default", not "blank". */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}
