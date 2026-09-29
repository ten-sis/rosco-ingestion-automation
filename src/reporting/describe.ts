/**
 * Plain-English one-liners for scenario steps and expectations. Used as `test.step` titles by the
 * runner, so the HTML report and the run summary name the step or checkpoint that failed, and by
 * the summary to print what each scenario asserts.
 */
import type {
  AssigneeExpectation,
  DriverEventExpectation,
  Expectation,
  Step,
  ThresholdEventExpectation,
  TripRef,
} from '../scenario/types';

function assignee(value: AssigneeExpectation): string {
  if (value === 'unchanged') return 'unchanged';
  return value === null ? 'none' : value;
}

function tripRef(ref: TripRef | undefined): string {
  if (ref === undefined || ref === 'latest') return 'latest trip';
  if (ref === 'first') return 'first trip';
  return `${ref.assetRef === 'secondary' ? 'secondary asset ' : ''}trip #${ref.index}`;
}

function driverEvent(exp: DriverEventExpectation): string {
  const parts = [`${exp.count ?? 1} ${exp.type ?? 'row'} for ${exp.driver ?? 'unidentified'}`];
  if (exp.isAssigneeSource !== undefined) parts.push(`assignee source ${String(exp.isAssigneeSource)}`);
  if (exp.tripLink) {
    parts.push(exp.tripLink.state === 'linked' ? `linked to ${tripRef(exp.tripLink.tripRef)}` : 'unlinked');
  }
  if (exp.contactActive !== undefined) parts.push(`contact_active ${String(exp.contactActive)}`);
  if (exp.flags) {
    const set = Object.entries(exp.flags).map(([k, v]) => `${k}=${String(v)}`);
    if (set.length > 0) parts.push(`flags ${set.join(', ')}`);
  }
  if (exp.tripDriverSetAt) parts.push(`trip_driver_set_at ${exp.tripDriverSetAt}`);
  return parts.join(', ');
}

function thresholdEvent(exp: ThresholdEventExpectation): string {
  const on = tripRef(exp.tripRef);
  if (exp.noTransfers) return `no violations transferred on ${on}`;
  if (exp.allAssignedTo) return `all violations on ${on} assigned to ${exp.allAssignedTo}`;
  if (exp.stillAssignedTo) {
    return `${exp.stillAssignedTo.which} violation(s) on ${on} still assigned to ${exp.stillAssignedTo.driver}`;
  }
  return `violations on ${on}`;
}

/** e.g. "asset assignee A; latest trip assignee A; all violations on latest trip assigned to A". */
export function describeExpectation(exp: Expectation): string {
  const parts: string[] = [];
  if (exp.assetAssignee) {
    const which = exp.assetAssignee.assetRef === 'secondary' ? 'secondary asset' : 'asset';
    parts.push(`${which} assignee ${assignee(exp.assetAssignee.value)}`);
  }
  for (const t of exp.trips ?? []) {
    parts.push(`${tripRef(t.tripRef)} assignee ${assignee(t.assignee)}${t.type ? ` (${t.type})` : ''}`);
  }
  for (const d of exp.driverEvents ?? []) parts.push(`driver event: ${driverEvent(d)}`);
  for (const v of exp.thresholdEvents ?? []) parts.push(thresholdEvent(v));
  if (exp.driverEventRowCount !== undefined) parts.push(`${exp.driverEventRowCount} driver-event row(s) in total`);
  for (const l of exp.serviceLogs ?? []) parts.push(`${l.deployment} logs "${l.contains}"`);
  return parts.length > 0 ? parts.join('; ') : 'nothing';
}

/** e.g. "ident A (identDrv, atSec 180)" or "settle until tripEnded". */
export function describeStep(step: Step): string {
  const at = `atSec ${step.atSec}`;
  const secondary = 'assetRef' in step && step.assetRef === 'secondary' ? ' on secondary asset' : '';
  switch (step.kind) {
    case 'ignitionOn':
      return `ignition on${secondary} (${at})`;
    case 'ignitionOff':
      return `ignition off${secondary} (${at})`;
    case 'move':
      return `position frame${secondary} (${at})`;
    case 'harshEvent':
      return `harsh event ${step.severity ?? 'hardBrake'}${secondary} (${at})`;
    case 'ident':
      return 'redeliverOf' in step && step.redeliverOf
        ? `redeliver ident "${step.redeliverOf}" (${at})`
        : `ident ${step.driver ?? 'unidentified'}${step.type ? ` (${step.type}, ${at})` : ` (${at})`}`;
    case 'patchAssetAssignee':
      return `set asset assignee to ${step.driver ?? 'none'} by hand`;
    case 'patchTripAssignee':
      return `set trip assignee to ${step.driver ?? 'none'} by hand`;
    case 'deactivateContact':
      return `deactivate contact ${step.driver}`;
    case 'reactivateContact':
      return `reactivate contact ${step.driver}`;
    case 'setLicence':
      return `set licence ${step.licence} ${step.enabled ? 'on' : 'off'}`;
    case 'transferViolations':
      return 'transfer violations by hand';
    case 'settle':
      return `wait until ${step.until}`;
  }
}
