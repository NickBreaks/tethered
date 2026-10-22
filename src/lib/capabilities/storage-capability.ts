import type { SandboxCapability, CapabilityStubInfo } from './capability.js';

export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class LocalStorageBackend implements StorageBackend {
  private readonly prefix = '__sandbox_storage__:';

  getItem(key: string): string | null {
    return localStorage.getItem(this.prefix + key);
  }
  setItem(key: string, value: string): void {
    localStorage.setItem(this.prefix + key, value);
  }
  removeItem(key: string): void {
    localStorage.removeItem(this.prefix + key);
  }
}

export class MapStorageBackend implements StorageBackend {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

export class StorageCapability implements SandboxCapability {
  readonly name = 'storage';
  readonly description = 'Key-value storage via localStorage';
  readonly stubInfo: CapabilityStubInfo = {
    name: 'storage',
    type: 'object',
    methods: ['getItem', 'setItem', 'removeItem'],
  };

  constructor(private backend: StorageBackend = new LocalStorageBackend()) {}

  async invokeHost(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'getItem':
        return this.backend.getItem(String(args[0]));
      case 'setItem': {
        if (typeof args[1] !== 'string') {
          throw new Error('storage.setItem: value must be a string');
        }
        this.backend.setItem(String(args[0]), args[1]);
        return undefined;
      }
      case 'removeItem':
        this.backend.removeItem(String(args[0]));
        return undefined;
      default:
        throw new Error(`storage.${method} is not implemented`);
    }
  }
}
