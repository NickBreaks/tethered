// The capability contract is engine-neutral: a capability describes its
// guest API (`stubInfo`) and, when host-backed, services calls through
// `invokeHost`. Nothing on it hands out an engine context.
import type { SandboxCapability } from './capability.js';
import { StorageCapability, MapStorageBackend } from './storage-capability.js';
import { DiskCapability, MapDiskBackend } from './disk-capability.js';
import { FetchCapability } from './fetch-capability.js';
import { TimerCapability } from './timer-capability.js';
import type { ProxyAuth } from '../proxy/proxy-auth.js';

const stubProxyAuth = {
  proxyBase: () => null,
  authHeader: () => null,
} as unknown as ProxyAuth;

describe('SandboxCapability', () => {
  // `npm run typecheck` enforces this test. Vitest does not.
  it('has no inject member', () => {
    expectTypeOf<SandboxCapability>().not.toHaveProperty('inject');
  });

  it.each<[string, () => SandboxCapability]>([
    ['StorageCapability', () => new StorageCapability(new MapStorageBackend())],
    ['DiskCapability', () => new DiskCapability(new MapDiskBackend())],
    ['FetchCapability', () => new FetchCapability(stubProxyAuth)],
    ['TimerCapability', () => new TimerCapability()],
  ])('no built-in capability carries an inject method (%s)', (_name, make) => {
    const cap = make();
    expect('inject' in cap, cap.name).toBe(false);
  });
});
