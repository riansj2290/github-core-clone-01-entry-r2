import { createApp } from './src/server.ts';

// Entrypoint: bind an ephemeral port, register it with the env, then poll
// until the env says the trial is over and exit 0. The server itself lives
// in src/server.ts; this file only owns the harness lifecycle. With no env
// set, it serves standalone on a fixed port instead, so the forge can be
// started with one command and tried by hand.

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means a first register
 * already won, which is not this process's to fix. 400 and 405 are contract errors and end the program;
 * a network error or another status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200) return;
      if (res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register rejected with ${res.status}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('register rejected')) throw e;
    }
    await sleep(retryDelay(attempt));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, {
        method: 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200) {
        const body = (await res.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // The env may still be starting; retry below.
    }
    await sleep(retryDelay(attempt));
  }
}

const server = createApp();

if (ENV_URL === '') {
  // Standalone mode: no harness env, so serve on a fixed port until killed.
  const port = parseInt(process.env.PORT ?? '3000', 10) || 3000;
  await new Promise<void>((resolve) => {
    server.listen(port, () => resolve());
  });
  process.stderr.write(`[entry] serving without an env on http://127.0.0.1:${port}\n`);
  await new Promise(() => {});
}

await new Promise<void>((resolve) => {
  server.listen(0, () => resolve());
});
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
if (port === 0) {
  process.stderr.write('[entry] failed to bind an ephemeral port\n');
  process.exit(1);
}
await register(port);
await waitForDone();
server.close();
process.exit(0);
