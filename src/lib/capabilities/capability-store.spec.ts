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

  it('should register a capability', () => {
    registry.register(mockCapability('console'));
    expect(registry.capabilities.get()).toEqual([
      expect.objectContaining({ name: 'console', enabled: false }),
    ]);
  });

  it('should register capabilities as disabled by default', () => {
    registry.register(mockCapability('console'));
    expect(registry.isEnabled('console')).toBe(false);
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
    registry.register(mockCapability('console'));
    registry.register(mockCapability('fetch'));
    registry.setEnabled('console', true);

    const enabled = registry.enabledCapabilities.get();
    expect(enabled.length).toBe(1);
    expect(enabled[0].name).toBe('console');
  });

  it('should reflect enabled state via isEnabled', () => {
    registry.register(mockCapability('timer'));
    expect(registry.isEnabled('timer')).toBe(false);
    registry.setEnabled('timer', true);
    expect(registry.isEnabled('timer')).toBe(true);
    registry.setEnabled('timer', false);
    expect(registry.isEnabled('timer')).toBe(false);
  });

  it('should not throw for unknown capability name', () => {
    expect(() => registry.setEnabled('nonexistent', true)).not.toThrow();
  });

  it('notifies capabilities subscribers on register/toggle, not on no-op toggles', () => {
    registry.register(mockCapability('console'));
    const seen: boolean[] = [];
    registry.capabilities.subscribe((caps) => seen.push(caps[0].enabled));
    registry.setEnabled('console', true);
    registry.setEnabled('nonexistent', true);
    expect(seen).toEqual([true]);
  });
});
