/**
 * Records every fixture this run creates, so a human (or a future cleanup tool — not part of this
 * module) can find and reap them. One manifest per worker run, written to `.runs/<runId>.json`.
 *
 * This is a process-lifetime append-only log, not a value object handed around by the scenario
 * contract, so — unlike everywhere else in this module — it is a deliberate, narrow exception to
 * the immutability rule: `recordCreated` pushes into a module-level mutable array. `writeManifest`
 * still builds and serializes an immutable snapshot at write time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURE_PREFIX } from '../constants';

export interface RunManifest {
  runId: string;
  startedAt: string;
  /** Every fixture the run used. `reused: true` marks one found from an earlier run, not created. */
  created: Array<{ kind: string; id: string; note?: string; reused?: true }>;
}

let runId: string | undefined;
let startedAt: string | undefined;
const created: RunManifest['created'] = [];

/** The run id for this worker process, generated on first use and stable thereafter. */
export function currentRunId(): string {
  if (!runId) {
    runId = `${FIXTURE_PREFIX}-${Date.now()}`;
    startedAt = new Date().toISOString();
  }
  return runId;
}

/** Records one created fixture (asset, tracker, contact, association, ...). */
export function recordCreated(kind: string, id: string, note?: string): void {
  currentRunId();
  created.push(note === undefined ? { kind, id } : { kind, id, note });
}

/** Records one fixture this run found from an earlier run and reused instead of creating. */
export function recordReused(kind: string, id: string, note?: string): void {
  currentRunId();
  created.push(note === undefined ? { kind, id, reused: true } : { kind, id, note, reused: true });
}

/** Writes the manifest accumulated so far to `.runs/<runId>.json`, creating the directory if needed. */
export function writeManifest(): void {
  const manifest: RunManifest = {
    runId: currentRunId(),
    startedAt: startedAt ?? new Date().toISOString(),
    created: [...created],
  };
  const dir = path.join(process.cwd(), '.runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${manifest.runId}.json`), JSON.stringify(manifest, null, 2));
}
