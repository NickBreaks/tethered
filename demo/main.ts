// The tethered demo: one runtime, the four built-in capabilities, a fetch
// allowlist, Run and Stop. Plain DOM, no framework.
//
// It imports the package source. An app would import 'tethered' and build
// its worker factory from 'tethered/js-worker?url' (see docs/usage.md).
import {
  createSandboxRuntime,
  DiskCapability,
  FetchCapability,
  MapDiskBackend,
  StorageCapability,
  TimerCapability,
  type OutputEntry,
} from '../src/index.js';

const EXAMPLES: Readonly<Record<string, string>> = {
  'Hello + fetch': `console.log('Hello from the sandbox');

// Host calls look synchronous to the guest. hello.json is served by this
// page, so its host must be on the allowlist.
const res = fetch('hello.json');
console.log('status', res.status);
const data = res.json();
console.log(data.greeting);

data.numbers.reduce((a, b) => a + b, 0);`,
  'Blocked host': `// Not on the allowlist: refused on the host before any request is made.
fetch('https://blocked.example.net/secrets');`,
  'Timer': `setTimeout(() => console.log('timer fired'), 100);
console.log('timer scheduled');`,
  'Storage + disk': `storage.setItem('visits', String(Number(storage.getItem('visits') ?? 0) + 1));
console.log('visits', storage.getItem('visits'));

disk.writeFile('/notes.txt', 'written by the guest');
console.log(disk.listFiles('/'), disk.readFile('/notes.txt'));`,
  'Infinite loop': `// Press Stop: the worker is terminated and a fresh one takes over.
while (true) {}`,
};

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing from the page`);
  return found as T;
}

const codeInput = el<HTMLTextAreaElement>('code');
const runButton = el<HTMLButtonElement>('run');
const stopButton = el<HTMLButtonElement>('stop');
const statusText = el<HTMLSpanElement>('status');
const outputList = el<HTMLOListElement>('output');
const allowHostsInput = el<HTMLInputElement>('allow-hosts');
const toggles = {
  fetch: el<HTMLInputElement>('cap-fetch'),
  storage: el<HTMLInputElement>('cap-storage'),
  disk: el<HTMLInputElement>('cap-disk'),
  timer: el<HTMLInputElement>('cap-timer'),
};

// A Vite-recognised worker URL: bundled into its own chunk by the build.
const rt = createSandboxRuntime({
  jsWorkerFactory: () =>
    new Worker(new URL('../src/js-worker.ts', import.meta.url), { type: 'module' }),
  timeoutMs: 30_000,
});

rt.registry.register(new StorageCapability());
rt.registry.register(new DiskCapability(new MapDiskBackend()));
rt.registry.register(new TimerCapability());

/** Comma- or space-separated hosts from the allowlist input. */
function allowHosts(): string[] {
  return allowHostsInput.value.split(/[\s,]+/).filter((h) => h !== '');
}

/**
 * Applies the toggles and the allowlist. Registering a capability again
 * replaces it (disabled), so the fetch policy is rebuilt before each run.
 * Returns an error message for an invalid allowlist entry.
 */
function applySettings(): string | null {
  let error: string | null = null;
  try {
    rt.registry.register(new FetchCapability(rt.auth, { allowHosts: allowHosts() }));
  } catch (e) {
    error = `Fetch allowlist: ${(e as Error).message}`;
  }
  for (const [name, toggle] of Object.entries(toggles)) {
    rt.registry.setEnabled(name, toggle.checked && !(name === 'fetch' && error));
  }
  return error;
}

function append(entry: Pick<OutputEntry, 'type' | 'content'>): void {
  const item = document.createElement('li');
  item.className = entry.type;
  item.textContent = entry.content; // guest-controlled: text only
  outputList.append(item);
}

function setStatus(text: string): void {
  statusText.textContent = text;
}

rt.js.onOutput(append);
rt.js.isRunning.subscribe((running) => {
  runButton.disabled = running || !rt.js.ready.get();
  stopButton.disabled = !running;
});

let stopRequested = false;

async function run(): Promise<void> {
  stopRequested = false;
  outputList.replaceChildren();
  const settingsError = applySettings();
  if (settingsError) append({ type: 'warn', content: `${settingsError} (fetch disabled for this run)` });
  setStatus('Running...');
  const result = await rt.facade.execute(codeInput.value);
  // The error usually arrived as an output entry already.
  const shown = [...outputList.children].some((li) => li.textContent?.includes(result.error ?? ''));
  if (result.error && !shown) append({ type: 'error', content: result.error });
  const outcome = stopRequested ? 'stopped' : result.timedOut ? 'timed out' : result.success ? 'done' : 'failed';
  setStatus(`${outcome} in ${Math.round(result.durationMs)} ms`);
}

for (const [label, code] of Object.entries(EXAMPLES)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset['testid'] = `example-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  button.addEventListener('click', () => {
    codeInput.value = code;
  });
  el('examples').append(button);
}

codeInput.value = EXAMPLES['Hello + fetch'] ?? '';
allowHostsInput.value = ['example.com', location.hostname].join(', ');
runButton.addEventListener('click', () => void run());
stopButton.addEventListener('click', () => {
  stopRequested = true;
  setStatus('Stopping...');
  void rt.js.abort();
});

rt.js.initialize().then(
  () => {
    runButton.disabled = false;
    setStatus('Ready');
  },
  (e: unknown) => setStatus(`The worker failed to start: ${(e as Error).message}`),
);
