export interface CapabilityStubInfo {
  readonly name: string;
  readonly type: 'function' | 'object';
  readonly methods?: readonly string[];
  readonly globals?: readonly string[];
}

/**
 * A sandbox capability. Guest code runs in a web worker and never sees
 * the capability object. The capability only describes its guest API
 * and services the calls to it:
 *
 * - Host-backed (storage/disk/fetch): implement `invokeHost`. The worker
 *   installs one guest function per `stubInfo` method/global. Each guest
 *   call suspends the guest. The worker relays the call to the main
 *   thread, and the call arrives here with plain structured-clone args.
 *   Throw to raise an error in the guest. Optionally, `setupScript` wraps
 *   the raw bridge functions in guest JS.
 *
 * - Built into the runner (timer): no `invokeHost`. The worker supplies
 *   the guest API. The capability is only its toggle.
 *
 * A capability that has no `invokeHost` and is not built in is only a
 * toggle. It installs nothing. For all capabilities, when a capability is
 * disabled, the worker installs stubs that throw. `stubInfo` sets the
 * shape of these stubs.
 */
export interface SandboxCapability {
  readonly name: string;
  readonly description: string;
  readonly stubInfo: CapabilityStubInfo;
  invokeHost?(method: string, args: unknown[]): Promise<unknown>;
  readonly setupScript?: string;
  cleanup?(): void | Promise<void>;
}
