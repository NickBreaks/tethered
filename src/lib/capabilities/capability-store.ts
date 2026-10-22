import { createValue, derived } from '../shared/readable-value.js';
import type { SandboxCapability } from './capability.js';

interface RegistryEntry {
  capability: SandboxCapability;
  enabled: boolean;
}

/** UI-facing summary of one registered capability. */
export interface CapabilityInfo {
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
}

/**
 * Tracks the registered capabilities and which of them are enabled.
 * Both runners read the enabled set at the start of every run.
 */
export class CapabilityStore {
  readonly #entries = createValue<Map<string, RegistryEntry>>(new Map());

  readonly capabilities = derived([this.#entries], (): CapabilityInfo[] =>
    [...this.#entries.get().values()].map((e) => ({
      name: e.capability.name,
      description: e.capability.description,
      enabled: e.enabled,
    })),
  );

  readonly enabledCapabilities = derived([this.#entries], () =>
    [...this.#entries.get().values()].filter((e) => e.enabled).map((e) => e.capability),
  );

  register(capability: SandboxCapability): void {
    this.#entries.update((map) => {
      const next = new Map(map);
      next.set(capability.name, { capability, enabled: false });
      return next;
    });
  }

  setEnabled(name: string, enabled: boolean): void {
    this.#entries.update((map) => {
      const entry = map.get(name);
      if (!entry) return map;
      const next = new Map(map);
      next.set(name, { ...entry, enabled });
      return next;
    });
  }

  isEnabled(name: string): boolean {
    return this.#entries.get().get(name)?.enabled ?? false;
  }

  getCapability(name: string): SandboxCapability | undefined {
    return this.#entries.get().get(name)?.capability;
  }

  getAll(): SandboxCapability[] {
    return [...this.#entries.get().values()].map((e) => e.capability);
  }

  dispose(): void {
    this.capabilities.dispose();
    this.enabledCapabilities.dispose();
    this.#entries.clear();
  }
}
