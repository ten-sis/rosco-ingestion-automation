/**
 * Pins the fixed identity that lets runs reuse fixture assets (PLAN/07-ASSET-REUSE.md). If the
 * fleet key drifts, every fleet silently gets a new asset again. If the tracker check loosens,
 * provisioning could drive telemetry through a real device installed on a fixture asset.
 *
 * Pure functions only. No `ApiClient`, no HTTP. Not tagged `@mutating`.
 */
import { test, expect } from '@playwright/test';
import { fixtureAssetKey, fixtureContactEmail, isFixtureTennaCam } from '../../src/fixtures/identity';

test.describe('fixtureAssetKey', () => {
  test('is the prefix plus the label, with no run id', () => {
    expect(fixtureAssetKey('fr-live')).toBe('[FRTest]-fr-live');
    expect(fixtureAssetKey('fr-live-secondary')).toBe('[FRTest]-fr-live-secondary');
  });

  test('puts a namespace between the prefix and the label', () => {
    expect(fixtureAssetKey('fr-live', 'mfm')).toBe('[FRTest]-mfm-fr-live');
  });

  test('treats an empty namespace as none', () => {
    expect(fixtureAssetKey('fr-live', '')).toBe('[FRTest]-fr-live');
  });
});

test.describe('isFixtureTennaCam', () => {
  const fixture = {
    type: 'TennaCAM 2.0',
    serial_number: '[FRTest]-gms-4f992273-aad',
    secondary_tracker_serial_number: '[FRTest]-veh-c8aefee8-12f',
  };

  test('accepts a TennaCAM 2.0 with fixture serials', () => {
    expect(isFixtureTennaCam(fixture)).toBe(true);
  });

  test('rejects a real device serial', () => {
    expect(isFixtureTennaCam({ ...fixture, serial_number: '015974001030484' })).toBe(false);
  });

  test('rejects a real Rosco vehicle id', () => {
    expect(isFixtureTennaCam({ ...fixture, secondary_tracker_serial_number: '994513895876' })).toBe(false);
  });

  test('rejects a missing Rosco vehicle id', () => {
    expect(isFixtureTennaCam({ ...fixture, secondary_tracker_serial_number: null })).toBe(false);
  });

  test('rejects another tracker type with fixture-looking serials', () => {
    expect(isFixtureTennaCam({ ...fixture, type: 'TennaCAM OBDII' })).toBe(false);
  });
});

test.describe('fixtureContactEmail', () => {
  const accountId = '24beb019-b03f-4452-b145-3dbd6d5e30b3';

  test('is a reserved-domain address that carries the account and the driver', () => {
    expect(fixtureContactEmail(accountId, 'A')).toBe(`frtest+${accountId}-a@example.com`);
  });

  test('differs per account, since contact emails are unique across accounts', () => {
    expect(fixtureContactEmail(accountId, 'A')).not.toBe(fixtureContactEmail('5139da63-e480-42b5-a3de-1979fa559338', 'A'));
  });

  test('differs per driver', () => {
    expect(fixtureContactEmail(accountId, 'A')).not.toBe(fixtureContactEmail(accountId, 'B'));
  });
});
