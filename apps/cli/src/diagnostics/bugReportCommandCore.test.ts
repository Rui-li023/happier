import { describe, expect, it } from 'vitest';

import { runBugReportCommand } from './bugReportCommandCore';

describe('runBugReportCommand export mode', () => {
  it('writes a local bundle without invoking the submission service', async () => {
    let writtenPath = '';
    let writtenContents = '';
    let submitted = false;

    const result = await runBugReportCommand([
      '--title', 'Export diagnostics',
      '--summary', 'Capture diagnostics locally',
      '--include-diagnostics',
      '--accept-privacy-notice',
      '--dry-run',
      '--output', '/tmp/diagnostics.json',
    ], {
      getActiveServerProfile: async () => ({
        id: 'server-1',
        name: 'Test server',
        serverUrl: 'https://server.example',
        webappUrl: 'https://server.example',
      }),
      fetchBugReportsFeature: async () => ({
        enabled: false,
        providerUrl: null,
        defaultIncludeDiagnostics: true,
        acceptedArtifactKinds: [],
        maxArtifactBytes: 10_000,
        contextWindowMs: 60_000,
        uploadTimeoutMs: 1_000,
      } as any),
      collectDiagnosticsArtifacts: async () => ({
        artifacts: [{
          filename: 'diagnostics.txt',
          sourceKind: 'cli',
          contentType: 'text/plain',
          content: 'diagnostic text',
        }],
        environment: {
          appVersion: '0.2.13',
          platform: 'darwin',
          deploymentType: 'cloud',
          serverUrl: 'https://server.example',
        },
      }),
      submitBugReport: async () => {
        submitted = true;
        throw new Error('submission should not run');
      },
      searchSimilarIssues: async () => ({ issues: [] }),
      isInteractiveTerminal: () => false,
      promptInput: async () => '',
      writeExportFile: async (path, contents) => {
        writtenPath = path;
        writtenContents = contents;
      },
    });

    expect(result).toMatchObject({
      mode: 'exported',
      outputPath: '/tmp/diagnostics.json',
      artifactCount: 1,
    });
    expect(JSON.parse(writtenContents).artifacts[0].content).toBe('diagnostic text');
    expect(writtenPath).toBe('/tmp/diagnostics.json');
    expect(submitted).toBe(false);
  });
});
