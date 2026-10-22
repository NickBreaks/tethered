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
  it('A22: has no inject member', () => {
    const cap: SandboxCapability = {
      name: 'probe',
      description: 'probe',
      stubInfo: { name: 'probe', type: 'function' },
      // @ts-expect-error A22: inject is not part of SandboxCapability
      inject: () => {},
    };
    type HasInject = 'inject' extends keyof SandboxCapability ? true : false;
    const hasInject: HasInject = false;
    expect(hasInject).toBe(false);
    expect(cap.name).toBe('probe');
  });

  it('A22: no built-in capability carries an inject method', () => {
    const caps: SandboxCapability[] = [
      new StorageCapability(new MapStorageBackend()),
      new DiskCapability(new MapDiskBackend()),
      new FetchCapability(stubProxyAuth),
      new TimerCapability(),
    ];
    for (const cap of caps) {
      expect('inject' in cap, cap.name).toBe(false);
    }
  });
});
