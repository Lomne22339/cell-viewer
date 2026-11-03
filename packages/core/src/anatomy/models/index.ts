import type { OrganModel } from '../types';
import { OrganRegistry } from '../registry';
import { body } from './body';
import { heart } from './heart';
import { brain } from './brain';
import { liver } from './liver';
import { pancreas } from './pancreas';

/** Built-in organs in panel order. To add one, write a model and append it here. */
export const BUILTIN_MODELS: OrganModel[] = [body, heart, brain, liver, pancreas];

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
