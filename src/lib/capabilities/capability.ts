export interface CapabilityStubInfo {
  readonly name: string;
  readonly type: 'function' | 'object';
  readonly methods?: readonly string[];
  readonly globals?: readonly string[];
}

/**
 * A sandbox capability. Guest code runs in a web worker and never sees
 * the capability object itself; the capability only describes its guest
 * API and services calls to it:
 *
 * - Host-backed (storage/disk/fetch): implement `invokeHost`. The worker
 *   installs one guest function per `stubInfo` method/global; each guest
 *   call suspends the guest, is relayed to the main thread and lands here
 *   with plain structured-clone args. Throw to raise an error in the
 *   guest. `setupScript` optionally wraps the raw bridge functions in
 *   guest JS.
 *
 * - Built into the runner (timer): no `invokeHost`. The worker provides
 *   the guest API itself; the capability is just its toggle.
 *
 * Without `invokeHost` (and not built in) a capability is a pure toggle
 * that installs nothing. When a capability is disabled, the worker
 * installs throwing stubs shaped by `stubInfo` either way.
 */
export interface SandboxCapability {
  readonly name: string;
  readonly description: string;
  readonly stubInfo: CapabilityStubInfo;
  invokeHost?(method: string, args: unknown[]): Promise<unknown>;
  readonly setupScript?: string;
  cleanup?(): void | Promise<void>;
}
