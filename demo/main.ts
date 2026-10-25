// The tethered demo: one runtime, the four built-in capabilities, a fetch
// allowlist, Run and Stop. Plain DOM, no framework.
//
// It imports the package source. A real app imports 'tethered' and builds
// its worker factory from 'tethered/js-worker?url' (see docs/usage.md).
import {
  createSandboxRuntime,
  DiskCapability,
  FetchCapability,
  MapDiskBackend,
  StorageCapability,
  TimerCapability,
  type OutputEntry,
  type SandboxCapability,
} from '../src/index.js';

const EXAMPLES: Readonly<Record<string, string>> = {
  'Hello + fetch': `console.log('Hello from the sandbox');

// Host calls look synchronous to the guest. hello.json is a file of this
// demo. The demo lets the guest fetch its own files, and no other path
// on this host.
const res = fetch('hello.json');
console.log('status', res.status);
const data = res.json();
console.log(data.greeting);

data.numbers.reduce((a, b) => a + b, 0);`,
  'Blocked host': `// Not on the allowlist: refused on the host before any request is made.
fetch('https://blocked.example.net/secrets');`,
  Timer: `setTimeout(() => console.log('timer fired'), 100);
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

// A worker URL that Vite recognises. The build bundles it into its own chunk.
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

/** The directory of this page. Same-origin guest fetches must stay in it. */
const demoDir = new URL('./', location.href);

/**
 * Lets the guest fetch the files of the demo (for example, hello.json),
 * but no other path on the host of the page. The demo does not put the
 * hostname of the page on the allowlist. On GitHub Pages, all the Pages
 * sites of an account share that hostname (`<user>.github.io`).
 * Same-origin fetches also send the cookies of the page.
 */
function withDemoFiles(fetchCap: FetchCapability): SandboxCapability {
  return {
    name: fetchCap.name,
    description: fetchCap.description,
    stubInfo: fetchCap.stubInfo,
    setupScript: fetchCap.setupScript,
    async invokeHost(method, args, context) {
      let url: URL | null = null;
      try {
        url = new URL(String(args[0]), location.href);
      } catch {
        // Not a URL: FetchCapability refuses it.
      }
      if (url?.origin === location.origin && !url.pathname.startsWith(demoDir.pathname)) {
        throw new Error(
          `fetch failed: only the files of the demo (${demoDir.pathname}) are allowed on this host.`,
        );
      }
      // Stop and the time limit abort the signal of the run. Then the
      // requests of the run abort.
      return fetchCap.invokeHost(method, args, context);
    },
  };
}

/**
 * Applies the toggles and the allowlist. A second registration of a
 * capability replaces it, and the new one is disabled. Thus the fetch
 * policy is rebuilt before each run.
 * Returns an error message for an invalid allowlist entry.
 */
function applySettings(): string | null {
  let error: string | null = null;
  try {
    const fetchCap = new FetchCapability(rt.auth, {
      allowHosts: [...allowHosts(), location.hostname],
    });
    rt.registry.register(withDemoFiles(fetchCap));
  } catch (e) {
    error = `Fetch allowlist: ${(e as Error).message}`;
  }
  for (const [name, toggle] of Object.entries(toggles)) {
    rt.registry.setEnabled(name, toggle.checked && !(name === 'fetch' && error));
  }
  return error;
}

/** The contents of the output entries of the current run. */
const shownContents = new Set<string>();

function append(entry: Pick<OutputEntry, 'type' | 'content'>): void {
  shownContents.add(entry.content);
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
  shownContents.clear();
  const settingsError = applySettings();
  if (settingsError)
    append({ type: 'warn', content: `${settingsError} (fetch disabled for this run)` });
  setStatus('Running...');
  const result = await rt.facade.execute(codeInput.value);
  // The error usually arrived as an output entry already.
  if (result.error && !shownContents.has(result.error))
    append({ type: 'error', content: result.error });
  const outcome = stopRequested
    ? 'stopped'
    : result.timedOut
      ? 'timed out'
      : result.success
        ? 'done'
        : 'failed';
  setStatus(`${outcome} in ${Math.round(result.durationMs)} ms`);
}

for (const [label, code] of Object.entries(EXAMPLES)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => {
    codeInput.value = code;
  });
  el('examples').append(button);
}

codeInput.value = EXAMPLES['Hello + fetch'] ?? '';
allowHostsInput.value = 'example.com';
el('demo-dir').textContent = demoDir.pathname;
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
