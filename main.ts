// main.ts — boot the forge and keep it up until the suite says the trial is over.
//
// The dance, per the kit's RULES.txt:
//   1. listen on a kernel-chosen port (never 8080 — the suite lives there),
//   2. tell the suite that port via POST $MAKEFUN_ENV_URL/register,
//   3. poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true},
//   4. leave with exit code 0.
//
// Nothing here keeps state between runs: no wall clock, no Math.random, no
// timestamps of our own. The forge itself (app.ts) owns all trial state.

import { createApp } from "./app.ts";

// The suite's origin, e.g. http://store:8080. Trailing slashes are stripped
// so the paths below join cleanly.
const suiteOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");

// How long to wait between attempts when the suite is briefly unreachable.
const RETRY_PAUSE_MS = 1000;

// Give up registering after this many tries instead of spinning forever.
const REGISTER_ATTEMPTS = 30;

// Port 0 asks the kernel to pick a free ephemeral port for us.
const EPHEMERAL_PORT = 0;

// The suite dials the address our register request came from, so we listen
// on every interface rather than loopback only.
const LISTEN_HOST = "0.0.0.0";

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// POST a JSON payload; true only on a 2xx answer. Any transport failure is
// a plain false so the caller can retry instead of crashing the process.
async function postJson(path: string, payload: unknown): Promise<boolean> {
  try {
    const reply = await fetch(`${suiteOrigin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return reply.ok;
  } catch {
    return false;
  }
}

// GET the suite's done flag. Returns true once the trial is finished, false
// while it is still running, and null when the answer could not be read at
// all (network blip, bad JSON) so the caller retries.
async function readDoneFlag(): Promise<boolean | null> {
  try {
    const reply = await fetch(`${suiteOrigin}/done`, { method: "GET" });
    if (!reply.ok) return null;
    const payload = (await reply.json()) as { done?: unknown };
    return payload.done === true;
  } catch {
    return null;
  }
}

// Announce our port to the suite, retrying briefly if it is not ready yet.
// Throws when the suite never answers — a forge nobody can reach scores 0,
// so failing loudly here is better than idling past the boot budget.
async function announcePort(port: number): Promise<void> {
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    if (await postJson("/register", { port })) return;
    await pause(RETRY_PAUSE_MS);
  }
  throw new Error(`suite did not accept our port after ${REGISTER_ATTEMPTS} tries`);
}

// Wait for the suite to finish its checks and workloads. Polls forever:
// the suite always answers eventually, and exiting early would throw the
// trial away.
async function waitUntilDone(): Promise<void> {
  for (;;) {
    if ((await readDoneFlag()) === true) return;
    await pause(RETRY_PAUSE_MS);
  }
}

async function boot(): Promise<void> {
  if (suiteOrigin === "") {
    throw new Error("MAKEFUN_ENV_URL is not set; cannot find the suite");
  }
  const forge = createApp();
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      forge.off("error", onError);
      reject(err);
    };
    forge.once("error", onError);
    forge.listen(EPHEMERAL_PORT, LISTEN_HOST, () => {
      forge.off("error", onError);
      resolve();
    });
  });
  const bound = forge.address();
  const port = typeof bound === "object" && bound !== null ? bound.port : 0;
  if (port === 0) {
    throw new Error("forge bound no port");
  }
  await announcePort(port);
  await waitUntilDone();
  // The trial is over and the suite has its export; leave cleanly.
  process.exit(0);
}

boot().catch((err: unknown) => {
  console.error("forge failed to start:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
