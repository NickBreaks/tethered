import type { SandboxCapability, CapabilityStubInfo } from './capability.js';

/**
 * Enables the guest timer globals (`setTimeout`, `setInterval`,
 * `clearTimeout`, `clearInterval`). The timers run inside the worker, on
 * virtual time. Thus this capability is only a descriptor. It gives the
 * toggle a name. It also sets the shape of the stubs that throw when the
 * capability is disabled. The worker drains pending timers before a run
 * settles.
 */
export class TimerCapability implements SandboxCapability {
  readonly name = 'timer';
  readonly description = 'setTimeout/setInterval and event loop draining';
  readonly stubInfo: CapabilityStubInfo = {
    name: 'timer',
    type: 'function',
    globals: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
  };
}
