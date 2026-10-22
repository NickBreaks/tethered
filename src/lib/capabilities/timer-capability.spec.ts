import type { SandboxCapability } from './capability.js';
import { TimerCapability } from './timer-capability.js';

// The guest-side timers (setTimeout & co. and the drain loop) are runner
// internals now; see src/workers/guest-timers.spec.ts.
describe('TimerCapability', () => {
  it('should expose name, description, and stubInfo with 4 globals', () => {
    const cap = new TimerCapability();
    expect(cap.name).toBe('timer');
    expect(typeof cap.description).toBe('string');
    expect(cap.description.length).toBeGreaterThan(0);
    expect(cap.stubInfo).toEqual({
      name: 'timer',
      type: 'function',
      globals: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
    });
  });

  it('A22: is a plain descriptor with no engine hooks and no host calls', () => {
    const cap: SandboxCapability = new TimerCapability();
    expect('inject' in cap).toBe(false);
    expect(cap.invokeHost).toBeUndefined();
    expect(Object.getOwnPropertyNames(TimerCapability.prototype)).toEqual(['constructor']);
  });
});
