import { vi } from 'vitest';
import { InProcessJsWorker } from './in-process-worker.js';
import { JsWorkerHost } from './worker-host.js';

describe('InProcessJsWorker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not hand queued messages to the host after terminate() during the host boot', async () => {
    let finishInit!: () => void;
    const init = vi
      .spyOn(JsWorkerHost.prototype, 'init')
      .mockImplementation(() => new Promise<void>((resolve) => (finishInit = resolve)));
    const handleMessage = vi
      .spyOn(JsWorkerHost.prototype, 'handleMessage')
      .mockImplementation(() => undefined);

    const worker = new InProcessJsWorker();
    worker.postMessage({ type: 'cap-result', callId: 1, ok: true, value: null });
    await vi.waitFor(() => expect(init).toHaveBeenCalledOnce());
    worker.terminate();
    finishInit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('reports init-error when the engine host cannot be imported', async () => {
    vi.resetModules();
    vi.doMock('./worker-host.js', () => {
      throw new Error('import failed');
    });
    try {
      const { InProcessJsWorker: Fresh } = await import('./in-process-worker.js');
      const worker = new Fresh();
      const msg = await new Promise<unknown>((resolve) =>
        worker.addEventListener('message', (e) => resolve((e as MessageEvent).data)),
      );
      expect(msg).toEqual({ type: 'init-error', message: expect.any(String) });
      worker.terminate();
    } finally {
      vi.doUnmock('./worker-host.js');
      vi.resetModules();
    }
  });
});
