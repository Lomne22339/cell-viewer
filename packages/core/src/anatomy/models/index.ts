import type { OrganModel } from '../types';
import { OrganRegistry } from '../registry';
import { body } from './body';
import { heart } from './heart';
import { brain } from './brain';
import { liver } from './liver';
import { pancreas } from './pancreas';

/**
 * The organs the viewer ships with, in the order the panel lists them.
 * To add an organ, write a model next to these and append it here.
 */
export const BUILTIN_MODELS: OrganModel[] = [body, heart, brain, liver, pancreas];

/**
 * A registry of every built-in model. With `onInvalid`, a model that fails
 * validation is reported and skipped instead of aborting, so one bad figure
 * costs one tab rather than the whole viewer. Tests omit it and fail loudly.
 */
export function createDefaultRegistry(
  onInvalid?: (model: OrganModel, error: Error) => void
): OrganRegistry {
  const registry = new OrganRegistry();
  for (const model of BUILTIN_MODELS) {
    try {
      registry.register(model);
    } catch (err) {
      if (!onInvalid) throw err;
      onInvalid(model, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return registry;
}
