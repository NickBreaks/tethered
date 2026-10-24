// Framework-free, dependency-free core. Code that this entry reaches must
// not import a package or refer to the worker modules. The default worker
// factories and the in-process engine fallback are in `tethered/workers`.
// Thus apps that bring their own factories do not bundle them. Framework
// bindings go in separate packages built on `ReadableValue`.

export { createSandboxRuntime } from './lib/create-sandbox-runtime.js';
export type { SandboxRuntime, SandboxRuntimeOptions } from './lib/create-sandbox-runtime.js';
export type { ReadableValue } from './lib/shared/readable-value.js';

export { RuntimeFacade } from './lib/runtime-facade.js';
export type { FacadeRunners } from './lib/runtime-facade.js';
export { JsRunner } from './lib/js/js-runner.js';
export type { JsRunnerOptions, RunInfo } from './lib/js/js-runner.js';

export { CapabilityStore } from './lib/capabilities/capability-store.js';
export type { CapabilityInfo } from './lib/capabilities/capability-store.js';
export type { SandboxCapability, CapabilityStubInfo } from './lib/capabilities/capability.js';
export {
  StorageCapability,
  LocalStorageBackend,
  MapStorageBackend,
} from './lib/capabilities/storage-capability.js';
export type { StorageBackend } from './lib/capabilities/storage-capability.js';
export { TimerCapability } from './lib/capabilities/timer-capability.js';
export { FetchCapability, type FetchCapabilityOptions } from './lib/capabilities/fetch-capability.js';
export {
  DiskCapability,
  MapDiskBackend,
  IndexedDBDiskBackend,
} from './lib/capabilities/disk-capability.js';
export type { DiskBackend } from './lib/capabilities/disk-capability.js';

export { ProxyAuth } from './lib/proxy/proxy-auth.js';
export type { ProxyAuthLike } from './lib/proxy/proxy-auth.js';

export type { OutputEntry, ExecutionResult } from './lib/shared/sandbox-types.js';
export type { CodeRunner, ExecuteOptions } from './lib/shared/code-runner.js';
export type {
  JsCapabilitySnapshot,
  JsMainToWorkerMsg,
  JsWorkerToMainMsg,
} from './lib/js/worker-protocol.js';
