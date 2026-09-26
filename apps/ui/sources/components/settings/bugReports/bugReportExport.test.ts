import { describe, expect, it, vi } from 'vitest';

import { exportBugReportDiagnosticsBundle } from './bugReportExport';

describe('exportBugReportDiagnosticsBundle', () => {
  it('writes and shares one serialized diagnostics bundle', async () => {
    const writeFile = vi.fn(async () => {});
    const shareFile = vi.fn(async () => {});

    const path = await exportBugReportDiagnosticsBundle({
      exportedAt: '2026-09-26T00:00:00.000Z',
      environment: {
        appVersion: '0.2.13',
        platform: 'ios',
        deploymentType: 'cloud',
      },
      artifacts: [{
        filename: 'logs.txt',
        sourceKind: 'ui-mobile',
        contentType: 'text/plain',
        content: 'hello',
      }],
      deps: {
        cacheDirectory: 'file:///cache/',
        now: () => 123,
        writeFile,
        shareFile,
      },
    });

    expect(path).toBe('file:///cache/happier-diagnostics-123.json');
    expect(writeFile).toHaveBeenCalledWith(
      path,
      expect.stringContaining('"schemaVersion": 1'),
    );
    expect(shareFile).toHaveBeenCalledWith(path);
  });
});
