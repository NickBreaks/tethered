import type { SandboxCapability, CapabilityStubInfo } from './capability.js';

/**
 * Enables the guest timer globals (`setTimeout`, `setInterval`,
 * `clearTimeout`, `clearInterval`). The timers themselves run inside the
 * worker, on virtual time, so this capability is only a descriptor: it
 * gives the toggle a name and shapes the throwing stubs installed when
 * it is disabled. Pending timers are drained before a run settles.
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
