import { describe, expect, it } from 'vitest';

import {
  buildBugReportExportBundle,
  serializeBugReportExportBundle,
} from './bugReports.js';

describe('bug report export bundle', () => {
  it('serializes the same redacted artifacts used by submission with byte sizes and a schema version', () => {
    const bundle = buildBugReportExportBundle({
      exportedAt: '2026-09-26T00:00:00.000Z',
      environment: {
        appVersion: '0.2.13',
        platform: 'android',
        deploymentType: 'cloud',
      },
      artifacts: [{
        filename: 'app-console.log',
        sourceKind: 'ui-mobile',
        contentType: 'text/plain',
        content: 'hello',
      }],
    });

    expect(bundle).toEqual({
      schemaVersion: 1,
      exportedAt: '2026-09-26T00:00:00.000Z',
      environment: {
        appVersion: '0.2.13',
        platform: 'android',
        deploymentType: 'cloud',
      },
      artifacts: [{
        filename: 'app-console.log',
        sourceKind: 'ui-mobile',
        contentType: 'text/plain',
        sizeBytes: 5,
        content: 'hello',
      }],
    });
    expect(JSON.parse(serializeBugReportExportBundle(bundle))).toEqual(bundle);
  });
});
