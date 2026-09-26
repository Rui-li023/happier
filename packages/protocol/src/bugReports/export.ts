import type { BugReportArtifactPayload, BugReportEnvironmentPayload, BugReportFormPayload } from './types.js';
import { utf8ByteLength } from './utf8.js';

export type BugReportExportArtifact = BugReportArtifactPayload & {
  sizeBytes: number;
};

export type BugReportExportBundle = {
  schemaVersion: 1;
  exportedAt: string;
  form?: BugReportFormPayload;
  environment: BugReportEnvironmentPayload;
  artifacts: BugReportExportArtifact[];
};

export function buildBugReportExportBundle(input: {
  exportedAt?: string;
  form?: BugReportFormPayload;
  environment: BugReportEnvironmentPayload;
  artifacts: readonly BugReportArtifactPayload[];
}): BugReportExportBundle {
  return {
    schemaVersion: 1,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    ...(input.form ? { form: input.form } : {}),
    environment: input.environment,
    artifacts: input.artifacts.map((artifact) => ({
      ...artifact,
      sizeBytes: utf8ByteLength(String(artifact.content ?? '')),
    })),
  };
}

export function serializeBugReportExportBundle(bundle: BugReportExportBundle): string {
  return JSON.stringify(bundle, null, 2) + '\n';
}
