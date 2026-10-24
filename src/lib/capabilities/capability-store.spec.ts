import { vi } from 'vitest';
import { CapabilityStore } from './capability-store.js';
import type { SandboxCapability } from './capability.js';

function mockCapability(name: string, description = 'test'): SandboxCapability {
  return {
    name,
    description,
    stubInfo: { name, type: 'function' },
  };
}

describe('CapabilityStore', () => {
  let registry: CapabilityStore;

  beforeEach(() => {
    registry = new CapabilityStore();
  });

  afterEach(() => {
    registry.dispose();
  });

  it('should register a capability', () => {
    const cap = mockCapability('console', 'Console output');
    registry.register(cap);
    expect(registry.capabilities.get()).toEqual([
      { name: 'console', description: 'Console output', enabled: false },
    ]);
    expect(registry.getCapability('console')).toBe(cap);
    expect(registry.getAll()).toEqual([cap]);
  });

  it('should register capabilities as disabled by default', () => {
    registry.register(mockCapability('console'));
    expect(registry.isEnabled('console')).toBe(false);
    expect(registry.enabledCapabilities.get()).toEqual([]);
  });

  it('should enable a capability', () => {
    registry.register(mockCapability('console'));
    registry.setEnabled('console', true);
    expect(registry.isEnabled('console')).toBe(true);
  });

  it('should disable a capability', () => {
    registry.register(mockCapability('console'));
    registry.setEnabled('console', true);
    registry.setEnabled('console', false);
    expect(registry.isEnabled('console')).toBe(false);
  });

  it('should return only enabled capabilities', () => {
    const consoleCap = mockCapability('console');
    registry.register(consoleCap);
    registry.register(mockCapability('fetch'));
    registry.setEnabled('console', true);

    expect(registry.enabledCapabilities.get()).toEqual([consoleCap]);
    expect(registry.enabledCapabilities.get()[0]).toBe(consoleCap);
  });

  it('getAll() returns every registered capability in registration order, enabled or not', () => {
    const a = mockCapability('a');
    const b = mockCapability('b');
    registry.register(a);
    registry.register(b);
    registry.setEnabled('b', true);
    expect(registry.getAll()).toEqual([a, b]);
  });

  it('should not throw for unknown capability name', () => {
    expect(() => registry.setEnabled('nonexistent', true)).not.toThrow();
    expect(registry.isEnabled('nonexistent')).toBe(false);
    expect(registry.getCapability('nonexistent')).toBeUndefined();
    expect(registry.capabilities.get()).toEqual([]);
  });

  it('notifies capabilities subscribers on register/toggle, not on no-op toggles', () => {
    registry.register(mockCapability('console'));
    const seen: boolean[] = [];
    registry.capabilities.subscribe((caps) => seen.push(caps[0].enabled));
    registry.setEnabled('console', true);
    registry.setEnabled('nonexistent', true);
    expect(seen).toEqual([true]);
    registry.register(mockCapability('fetch'));
    expect(seen).toEqual([true, true]);
  });

  it('dispose() drops every subscriber', () => {
    registry.register(mockCapability('console'));
    const onCaps = vi.fn();
    const onEnabled = vi.fn();
    registry.capabilities.subscribe(onCaps);
    registry.enabledCapabilities.subscribe(onEnabled);
    registry.dispose();
    registry.setEnabled('console', true);
    registry.register(mockCapability('fetch'));
    expect(onCaps).not.toHaveBeenCalled();
    expect(onEnabled).not.toHaveBeenCalled();
  });
});
