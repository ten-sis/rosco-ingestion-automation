/**
 * Service log reader: reads a deployment's pod logs with `kubectl logs`, for the one thing the
 * suite can only prove from a log line. O19 needs it: TrackIt standing down on a facial
 * recognition account leaves no trace in any table, only its `Skipping TrackIt assignee override`
 * info line (hapi-server-trackit `tripEventService.ts`).
 *
 * Uses the same kube context as `scripts/tunnels.sh` (`KUBE_CONTEXT`, default `Dv3A`), passed
 * explicitly so a default context switched to another cluster is never read by mistake.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertNotProduction } from '../env';

const run = promisify(execFile);

export function kubeContext(): string {
  const context = process.env.KUBE_CONTEXT ?? 'Dv3A';
  assertNotProduction('KUBE_CONTEXT', context);
  return context;
}

export interface DeploymentRef {
  namespace: string;
  deployment: string;
}

/**
 * Log lines from the deployment's pods since `since`. Reads every pod behind the deployment,
 * since spot reclaim on dv3 replaces pods often and the line may be on either side of a restart.
 * A pod that was deleted outright takes its log with it, which `podsStartedAfter` lets the caller
 * explain.
 */
export async function readDeploymentLogs(ref: DeploymentRef, since: Date): Promise<string[]> {
  const context = kubeContext();
  const pods = await deploymentPods(ref);
  const sinceSeconds = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 1_000));
  const lines: string[] = [];
  for (const pod of pods) {
    const { stdout } = await run(
      'kubectl',
      ['--context', context, '-n', ref.namespace, 'logs', pod.name, '--all-containers', `--since=${sinceSeconds}s`],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    lines.push(...stdout.split('\n'));
  }
  return lines;
}

interface Pod {
  name: string;
  startedAt: Date | undefined;
}

async function deploymentPods(ref: DeploymentRef): Promise<Pod[]> {
  const context = kubeContext();
  const { stdout: selectorJson } = await run('kubectl', [
    '--context', context, '-n', ref.namespace, 'get', 'deploy', ref.deployment, '-o', 'jsonpath={.spec.selector.matchLabels}',
  ]);
  const labels = JSON.parse(selectorJson) as Record<string, string>;
  const selector = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
  const { stdout } = await run('kubectl', ['--context', context, '-n', ref.namespace, 'get', 'pods', '-l', selector, '-o', 'json']);
  const items = (JSON.parse(stdout) as { items: Array<{ metadata: { name: string }; status?: { startTime?: string } }> }).items;
  return items.map((p) => ({ name: p.metadata.name, startedAt: p.status?.startTime ? new Date(p.status.startTime) : undefined }));
}

/** Names of the deployment's pods that started after `since`, i.e. replaced during the window. */
export async function podsStartedAfter(ref: DeploymentRef, since: Date): Promise<string[]> {
  return (await deploymentPods(ref)).filter((p) => p.startedAt && p.startedAt > since).map((p) => p.name);
}
