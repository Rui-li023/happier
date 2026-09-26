import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import {
  buildBugReportExportBundle,
  serializeBugReportExportBundle,
  type BugReportArtifactPayload,
  type BugReportEnvironmentPayload,
  type BugReportFormPayload,
} from '@happier-dev/protocol';

type BugReportExportFileDeps = {
  cacheDirectory?: string | null;
  now?: () => number;
  writeFile?: (path: string, contents: string) => Promise<void>;
  shareFile?: (path: string) => Promise<void>;
};

export async function exportBugReportDiagnosticsBundle(input: {
  environment: BugReportEnvironmentPayload;
  artifacts: readonly BugReportArtifactPayload[];
  form?: BugReportFormPayload;
  exportedAt?: string;
  deps?: BugReportExportFileDeps;
}): Promise<string> {
  const deps = input.deps ?? {};
  const cacheDirectory = deps.cacheDirectory ?? FileSystem.cacheDirectory;
  if (!cacheDirectory) {
    throw new Error('Diagnostics export is unavailable because no cache directory exists.');
  }

  const path = cacheDirectory + 'happier-diagnostics-' + String(deps.now?.() ?? Date.now()) + '.json';
  const bundle = buildBugReportExportBundle({
    exportedAt: input.exportedAt,
    form: input.form,
    environment: input.environment,
    artifacts: input.artifacts,
  });
  const contents = serializeBugReportExportBundle(bundle);

  const writeFile = deps.writeFile ?? (async (filePath, fileContents) => {
    await FileSystem.writeAsStringAsync(filePath, fileContents, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  });
  const shareFile = deps.shareFile ?? (async (filePath) => {
    if (!(await Sharing.isAvailableAsync())) {
      throw new Error('Diagnostics sharing is unavailable on this device.');
    }
    await Sharing.shareAsync(filePath, {
      mimeType: 'application/json',
      dialogTitle: 'Export diagnostics',
      UTI: 'public.json',
    });
  });

  await writeFile(path, contents);
  await shareFile(path);
  return path;
}
