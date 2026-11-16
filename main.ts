// Boot sequence for the forge process.
//
// The trial harness drives this process through a small handshake. The
// environment origin comes from MAKEFUN_ENV_URL, and the process:
//
//   * refuses to start when that variable is missing, because there would
//     be no environment to announce itself to;
//   * starts the forge on a kernel-chosen port, never a fixed one, since
//     the environment already owns 8080;
//   * tells the environment which port it picked, by POSTing to /register;
//   * keeps asking GET /done until the environment reports the trial is
//     finished, then shuts the server down and leaves with status 0.
//
// Nothing here touches the forge itself: all request handling lives in
// app.ts, and this file only wires the process up to the harness.

import { createApp as buildForge, createHttpApp as buildHttpForge } from './app.ts';

// Read the environment origin, dropping any trailing slashes.
const envOrigin = (): string => {
    const raw = process.env.MAKEFUN_ENV_URL;
    if (raw === undefined) return '';
    let cleaned = raw;
    while (cleaned.endsWith('/')) cleaned = cleaned.slice(0, -1);
    return cleaned;
};

// Demand an environment origin, or stop the process right away.
const requireEnvOrigin = (): string => {
    const origin = envOrigin();
    if (origin !== '') return origin;
    process.stderr.write('[entry] MAKEFUN_ENV_URL is missing: no environment to register with\n');
    process.exit(1);
};

const ENV_ORIGIN = requireEnvOrigin();

// Abort any single register or done request that runs longer than this.
const REQUEST_BUDGET_MS = 30_000;
// First pause between attempts, and the longest pause the backoff reaches.
const BACKOFF_FLOOR_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

// Wait `ms` milliseconds.
const pause = (ms: number): Promise<void> =>
    new Promise<void>((wake) => {
        setTimeout(wake, ms);
    });

// Run `step` until it reports completion, pausing longer after each miss,
// up to the backoff ceiling. A step that throws aborts the whole wait.
const retryUntilDone = async (step: () => Promise<boolean>): Promise<void> => {
    let waitMs = BACKOFF_FLOOR_MS;
    let settled = false;
    do {
        settled = await step();
        if (!settled) {
            await pause(waitMs);
            waitMs = Math.min(BACKOFF_CEILING_MS, waitMs * 2);
        }
    } while (!settled);
};

// Announce the bound port to the environment, retrying until it sticks.
// A 200 means the announcement landed; a 409 means some other entry got
// there first, which is equally final. 400 and 405 are contract failures
// and abort the process; anything else is treated as the environment still
// coming up and is retried.
const announcePort = async (port: number): Promise<void> => {
    await retryUntilDone(async () => {
        let reply: Response | null = null;
        try {
            reply = await fetch(`${ENV_ORIGIN}/register`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ port }),
                signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
            });
        } catch {
            // No reply at all: the environment may still be starting, so retry.
            return false;
        }
        if (reply.status === 200 || reply.status === 409) return true;
        if (reply.status === 400 || reply.status === 405) {
            throw new Error(`register got HTTP ${reply.status}: ${await reply.text()}`);
        }
        return false;
    });
};

// Ask the environment whether the trial is over, polling until it says so.
// A missing or late answer just means "not yet": the wait only ends when
// a reply parses as {"done": true}.
const awaitTrialEnd = async (): Promise<void> => {
    await retryUntilDone(async () => {
        try {
            const reply = await fetch(`${ENV_ORIGIN}/done`, {
                signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
            });
            if (!reply.ok) return false;
            const payload = (await reply.json()) as { done?: unknown };
            return payload.done === true;
        } catch {
            // No answer, or an unreadable one: the trial is still running.
            return false;
        }
    });
};

// The ephemeral TCP port the forge bound, or fail when it bound none.
const boundPortOf = (forge: { address(): unknown }): number => {
    const bound = forge.address();
    if (bound !== null && typeof bound === 'object' && 'port' in bound) return (bound as { port: number }).port;
    throw new Error('the forge did not bind an ephemeral TCP port');
};

// Bring the forge up, announce it, and stay alive until the trial ends.
// FORGE_TRANSPORT=http selects the node:http server (A/B measurement only);
// the default is the raw-TCP transport in transport.ts.
const run = async (): Promise<void> => {
    const forge = process.env.FORGE_TRANSPORT === 'http' ? buildHttpForge() : buildForge();
    await new Promise<void>((ready, failed) => {
        forge.once('error', failed);
        forge.listen(0, () => ready());
    });
    const port = boundPortOf(forge);
    process.stdout.write(`[entry] listening on port ${port}\n`);

    await announcePort(port);
    process.stdout.write('[entry] registered; waiting for the environment to finish\n');

    await awaitTrialEnd();
    forge.close();
    process.stdout.write('[entry] done\n');
};

void run().then(
    () => {
        process.exit(0);
    },
    (caught: unknown) => {
        const detail = caught instanceof Error ? caught.message : String(caught);
        process.stderr.write(`[entry] ${detail}\n`);
        process.exit(1);
    },
);
