// Framework-free, dependency-free core. Nothing reachable from this entry
// may import a package, nor reference the worker modules: the default
// worker factories and the in-process engine fallback live in
// `tethered/workers`, so apps that bring their own factories don't bundle
// them. Framework bindings belong in separate packages built on
// `ReadableValue`.

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
export { StorageCapability } from './lib/capabilities/storage-capability.js';
export { TimerCapability } from './lib/capabilities/timer-capability.js';
export { FetchCapability, type FetchCapabilityOptions } from './lib/capabilities/fetch-capability.js';
export {
  DiskCapability,
  MapDiskBackend,
  IndexedDBDiskBackend,
  normalizePath,
} from './lib/capabilities/disk-capability.js';
export type { DiskBackend } from './lib/capabilities/disk-capability.js';
export {
  openSandboxDisk,
  SANDBOX_DISK_DB_VERSION,
} from './lib/capabilities/sandbox-disk-db.js';

export { ProxyAuth } from './lib/proxy/proxy-auth.js';
export type { ProxyAuthLike } from './lib/proxy/proxy-auth.js';

export { serialize } from './lib/shared/serialize.js';
export type { OutputEntry, ExecutionResult } from './lib/shared/sandbox-types.js';
export type { CodeRunner, ExecuteOptions } from './lib/shared/code-runner.js';
export type {
  JsCapabilitySnapshot,
  JsMainToWorkerMsg,
  JsWorkerToMainMsg,
} from './lib/js/worker-protocol.js';
