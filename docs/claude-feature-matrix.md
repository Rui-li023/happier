# Claude Feature Matrix

This document captures the current low-level Claude implementation across the CLI, daemon, UI, direct-session plumbing, and QA surfaces. It is an internal inventory for architecture work, not end-user docs.

## Status legend

- `supported`: primary current path
- `partial`: shipped, but split across multiple paths or missing parity on one path
- `legacy`: still wired, but no longer the preferred path
- `unsupported`: intentionally absent today

## Runtime surfaces

| Feature | Status | Exact source files | Current behavior / special cases | Unified architecture migration notes |
| --- | --- | --- | --- | --- |
| Remote Agent SDK path (default remote runtime) | `supported` | `apps/cli/src/backends/claude/remote/claudeRemoteDispatch.ts`, `apps/cli/src/backends/claude/remote/claudeRemoteAgentSdk.ts`, `apps/cli/src/backends/claude/claudeRemoteLauncher.ts`, `apps/cli/src/backends/claude/remote/sessionStartPlan.ts`, `packages/agents/src/providerSettings/definitions/claudeRemote.ts` | Preferred remote path when `claudeRemoteAgentSdkEnabled === true`; supports setting-sources v2, partial streaming, slash-command capability publication, optional checkpoint capture, and advanced option allowlisting. | Make this the single remote runtime surface and remove the auth-error-only fallback contract from `claudeRemoteDispatch.ts`. |
| Legacy remote shim | `legacy` | `apps/cli/src/backends/claude/claudeRemote.ts`, `apps/cli/src/backends/claude/sdk/query.ts`, `apps/cli/src/backends/claude/sdk/index.ts`, `apps/cli/src/backends/claude/sdk/stream.ts`, `apps/cli/src/backends/claude/remote/claudeRemoteDispatch.ts` | Older stream-json runner still works and is the remote fallback when Agent SDK startup fails with a Claude auth error before additional prompts are consumed. | Retire after Agent SDK reaches full parity for all remaining startup/session-info edge cases. |
| Local interactive / attach path | `supported` | `apps/cli/src/backends/claude/runClaude.ts`, `apps/cli/src/backends/claude/claudeLocalLauncher.ts`, `apps/cli/src/backends/claude/claudeLocal.ts`, `apps/cli/src/backends/claude/session.ts`, `packages/agents/src/manifest.ts` | Canonical local path is Claude's own TUI; attach is tmux-oriented and exclusive-topology in metadata/UI contracts; `runClaude.ts` also has a fast-start attach path for terminal-local resumes. | Collapse local launch, attach, and fast-start attach behind one provider local-control descriptor instead of branching in `runClaude.ts`. |
| Execution runs | `supported` | `apps/cli/src/backends/claude/executionRuns/executionRunBackendFactory.ts`, `apps/cli/src/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend.ts`, `apps/cli/src/backends/claude/executionRuns/resolveClaudeExecutionRunPermissionPolicy.ts`, `apps/cli/src/agent/executionRuns/registry/executionRunBackendRegistry.ts`, `apps/cli/src/capabilities/registry/toolExecutionRuns.ts` | Claude execution runs already use an SDK-backed runtime, but it is a separate backend class with isolated `settings.json` and XDG roots rather than the normal remote-session launcher. | Converge user sessions and execution runs on one Claude runtime adapter so steering, capabilities, and checkpoint/sidechain behavior share the same plumbing. |
| Persisted Happier transcript ingestion | `supported` | `apps/cli/src/backends/claude/session.ts`, `apps/cli/src/backends/claude/claudeLocalLauncher.ts`, `apps/cli/src/backends/claude/claudeRemoteLauncher.ts`, `apps/cli/src/backends/claude/utils/sessionScanner.ts`, `apps/cli/src/backends/claude/utils/readClaudeSessionJsonlMessages.ts` | Local mode tails Claude JSONL files through `createSessionScanner`; remote mode forwards streamed SDK messages and still updates `claudeSessionId` / `claudeTranscriptPath` metadata when hooks reveal exact session info. | Normalize transcript provenance so local-scanned, remote-streamed, and imported history use one transcript-source envelope. |
| Linked direct transcript source (`.claude/projects/...jsonl`) | `supported` | `apps/cli/src/backends/claude/session.ts`, `apps/cli/src/backends/claude/directSessions/listClaudeSessionCandidates.ts`, `apps/cli/src/backends/claude/directSessions/pageClaudeTranscript.ts`, `apps/cli/src/backends/claude/directSessions/readAfterClaudeTranscript.ts`, `apps/cli/src/backends/claude/directSessions/resolveClaudeDirectSessionFile.ts` | When transcript storage is `direct`, `session.ts` writes `directSessionV1`; browse/tail reads provider-owned JSONL directly and supports backward paging plus forward tail-follow. | Replace `directSessionV1` and Claude-specific file cursors with a shared transcript-source contract used by browse, takeover, and handoff. |
| Sidechains, subagents, and team inbox | `partial` | `apps/cli/src/backends/claude/remote/sidechains/claudeTaskOutputSidechainImporter.ts`, `apps/cli/src/backends/claude/remote/sidechains/claudeRemoteSubagentFileCollector.ts`, `apps/cli/src/backends/claude/remote/teamInbox/claudeRemoteTeamInboxBridge.ts`, `apps/cli/src/backends/claude/utils/teamInbox/claudeTeamInboxCollector.ts`, `apps/ui/sources/sync/domains/session/participants/providers/claude/deriveClaudeTeamParticipants.ts`, `apps/ui/sources/components/tools/renderers/workflow/SubAgentRunView.tsx` | Remote mode has dedicated collectors for `Task` / `Agent` JSONL sidechains and team-inbox messages; UI then reconstructs team state, shutdown pruning, and run previews from normalized tool calls plus imported sidechain messages. | Centralize Claude sidechain/team normalization so CLI collectors and UI participant derivation stop re-encoding the same lifecycle rules. |

Development-source transcript ingestion and UI normalization share
`providers.claude.isClaudeInternalEventType` from `@happier-dev/agents` for
non-conversation records, including Claude SDK `command_lifecycle` status events.
Raw runtime observers receive these records before transcript filtering; filtering
does not establish message acceptance or foreground activity. UI normalization also
filters already-persisted internal records, while genuinely unknown output retains
the unsupported-output diagnostic.

## Session lifecycle surfaces

Development-source Unified Terminal delivery keeps observing canonical Pending
eligibility while its submitted prompt awaits provider acceptance. External manual
handling can retire that exact row without another Claude hook or terminal output;
the existing arbiter then releases the submitted head and admits the next prompt
without resending the retired input or manufacturing provider acceptance. The API
session client owns exact custody reconciliation and publishes the same Pending
wake when local custody changes.

In development source, Unified Terminal publishes its exact-host stop capability
as soon as the attachment is persisted, before metadata publication or provider
initialization can block. Explicit stop still destroys only that owned attachment;
stale attachment identities cannot destroy a replacement host.

In development source, the remote Agent SDK runner treats a live root
`message_start` from its owned session after a result as renewed foreground work.
This covers resume streams that emit a prior result before processing the supplied
prompt. The launcher starts the canonical turn and resets ready-notification
tracking, and the runner restores thinking and steering state until the next
result. Late deltas, replay, foreign-session messages, and child output alone do
not reopen the foreground turn.

Both remote runners use `remote/resultTurnBoundary.ts` to recognize a result with
a positive integer `queued_turn_count`. That result ends one provider turn while
another user turn remains queued, including after a nonfatal failed turn. The
runners retain foreground ownership and continue consuming provider output until
the terminal result; they preserve intermediate output and error diagnostics.
Results from older providers without this field retain their existing behavior.

Development-source SDK and local permission hooks share
`utils/buildClaudePermissionHookResponse.ts` for response serialization.
`PermissionRequest` approvals include `updatedInput` only when the arguments
actually change: Claude rechecks supplied replacement arguments against ask and
deny rules before applying `updatedPermissions`. Echoing the original arguments
can therefore refuse an approved operation and skip its saved allow rule.
Genuine rewrites remain subject to Claude's checks; `PreToolUse` still carries
the input needed for `AskUserQuestion` answers. Claude's Auto classifier remains
the permission authority before a request reaches these hooks.

| Feature | Status | Exact source files | Current behavior / special cases | Unified architecture migration notes |
| --- | --- | --- | --- | --- |
| Direct session browse/list | `supported` | `apps/cli/src/backends/claude/directSessions/listClaudeSessionCandidates.ts`, `apps/ui/sources/agents/providers/claude/directSessions/resolveClaudeBrowseSourceOptions.ts`, `apps/ui/sources/agents/providers/claude/uiBehavior.tsx` | UI exposes only one Claude direct source today: `{ kind: 'claudeConfig' }`; discovery walks `~/.claude/projects/**.jsonl` and lazily reads session titles. | Promote direct-source selection into the same provider runtime record used by resume/takeover instead of a Claude-only browse option. |
| Direct transcript import / takeover -> persisted Happier session | `supported` | `apps/cli/src/api/directSessions/import/importDirectSessionTranscript.ts`, `apps/cli/src/api/directSessions/takeover/resolveDirectTakeoverSpawnOptions.ts`, `apps/cli/src/api/machine/rpcHandlers.directSessions.ts`, `apps/cli/src/backends/claude/directSessions/getClaudeDirectSessionWorkingDirectory.ts`, `apps/cli/src/backends/claude/directSessions/resolveClaudeConfigDir.ts` | Claude takeovers import the direct transcript into Happier storage, delete `directSessionV1`, write `externalHistoryImportV1`, and respawn the same Happier session in `persisted` mode with `resume=<claudeSessionId>` plus `CLAUDE_CONFIG_DIR`. | Treat takeover as a first-class source transition on one session record, not as import + metadata surgery + respawn. |
| Manual cross-machine handoff | `supported` | `apps/cli/src/backends/claude/handoff/exportClaudeSessionBundle.ts`, `apps/cli/src/backends/claude/handoff/importClaudeSessionBundle.ts`, `apps/cli/src/session/handoff/exportSessionHandoffProviderBundle.ts`, `apps/cli/src/session/handoff/importSessionHandoffProviderBundle.ts` | Claude handoff exports raw transcript JSONL as base64, rehydrates it under the target machine's Claude config dir, and returns both a direct source and a vendor-resume plan. | Fold transcript copy, direct-source metadata, and resume plan into one canonical provider handoff payload. |
| Local <-> remote switching and attach | `supported` | `apps/cli/src/backends/claude/claudeLocalLauncher.ts`, `apps/cli/src/backends/claude/claudeRemoteLauncher.ts`, `apps/cli/src/backends/claude/session.ts`, `apps/cli/src/backends/claude/utils/ensureSessionInfoBeforeSwitch.ts`, `apps/cli/src/agent/localControl/createLocalRemoteModeController.ts` | Both launchers register `switch`/`abort` RPC handlers; switching waits for hook-derived session info before aborting so remote resumes the correct Claude session/transcript after local forks or compaction. | Keep one transport-neutral attach/switch controller and move Claude-specific session-id stabilization behind provider hooks only. |
| Permissions and approval routing | `supported` | `apps/cli/src/backends/claude/utils/permissionHandler.ts`, `apps/cli/src/backends/claude/localPermissions/localPermissionBridge.ts`, `apps/cli/src/backends/claude/utils/startHookServer.ts`, `apps/cli/src/backends/claude/utils/generateHookSettingsFileWithEnsuredRuntime.ts`, `apps/ui/sources/agents/providers/claude/core.ts` | Remote mode uses Happier-managed tool approval routing; local mode can surface the same permission prompts via the experimental local permission bridge, but the local subprocess still needs a restart for some spawn-time flag changes. | Converge local bridge and remote approval handling on one provider permission contract with explicit live-vs-next-spawn semantics. |
| Session controls: modes, settings sources, checkpoints, remote extras | `partial` | `packages/agents/src/providerSettings/definitions/claudeRemote.ts`, `apps/ui/sources/agents/providers/claude/settings/plugin.ts`, `apps/ui/sources/agents/providers/claude/core.ts`, `apps/cli/src/backends/claude/remote/claudeRemoteMetaState.ts`, `apps/cli/src/backends/claude/remote/resolveInitialClaudeRemoteMetaState.ts`, `apps/cli/src/backends/claude/remote/agentSdk/claudeAgentSdkSlashCommands.ts` | Claude exposes build/plan mode, remote setting sources (`claudeRemoteSettingSources` + `claudeRemoteSettingSourcesV2`), partial streaming, local permission bridge toggles, checkpoint capture, max-thinking override, TODO suppression, strict MCP, and advanced JSON allowlist; some controls are Agent-SDK-only. | Rename transport-branded / legacy settings into one controls schema and stop carrying both v1 and v2 setting-source formats. |
| Manual resume (`happier resume`, explicit `resume`, vendor `--resume`) | `supported` | `apps/cli/src/rpc/handlers/registerSessionHandlers.ts`, `apps/cli/src/backends/claude/runClaude.ts`, `apps/cli/src/backends/claude/session.ts`, `apps/cli/src/backends/claude/claudeLocal.ts`, `packages/agents/src/manifest.ts`, `packages/agents/src/sessionControls/vendorResumePolicy.ts` | Claude is a first-class vendor-resume provider keyed by `claudeSessionId`; local runs consume one-time `--resume` / `--continue` flags after spawn, and `session.ts` rewrites metadata when Claude forks to a new vendor session id. | Keep a single provider resume record carrying vendor id, transcript path, and source affinity instead of scattering them across session metadata fields. |
| Wake resume / background wake | `supported` | `apps/ui/sources/agents/runtime/resumeCapabilities.ts`, `apps/ui/sources/agents/providers/claude/core.ts`, `apps/ui/sources/agents/registry/registryUiBehavior.ts`, `packages/agents/src/sessionControls/vendorResumePolicy.ts` | Claude uses the generic vendor-resume wake path; unlike Codex/OpenCode there is no Claude-specific `buildWakeResumeExtras` override, so wake relies on persisted metadata plus the generic resume capability contract. | Replace generic wake heuristics plus provider-specific metadata fields with a serialized provider runtime descriptor that wake can replay directly. |

## Installables, auth, and coverage

| Feature | Status | Exact source files | Current behavior / special cases | Unified architecture migration notes |
| --- | --- | --- | --- | --- |
| Provider installables / runtime acquisition | `partial` | `packages/agents/src/providers/providerCliRuntime.ts`, `apps/cli/src/backends/claude/daemon/spawnHooks.ts`, `apps/ui/sources/capabilities/installablesRegistry.ts`, `apps/docs/content/docs/providers/claude.mdx` | Claude is `system-first`, accepts JS-file overrides, and uses Anthropic's vendor install recipe; there is no Happier-managed binary package comparable to Codex. | Make install policy explicit in one provider runtime catalog: system-first vendor-recipe, not an implicit absence of `managedInstall`. |
| CLI auth detection and local login launch | `supported` | `apps/cli/src/backends/claude/cli/auth/claudeCliAuthSpec.ts`, `apps/cli/src/backends/claude/index.ts`, `apps/cli/src/backends/claude/cli/command.ts`, `apps/ui/sources/agents/providers/claude/settings/plugin.ts` | Auth detection prefers `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`, then `~/.claude/.credentials.json`; provider settings can launch Claude's login flow through Happier. | Move all provider auth probing and launch behavior behind one transport-neutral auth-status/launch contract. |
| Cloud connect and connected-services materialization | `supported` | `apps/cli/src/backends/claude/cloud/connect.ts`, `apps/cli/src/backends/claude/cloud/authenticateClaudeSubscriptionOauth.ts`, `apps/cli/src/backends/claude/connectedServices/materializeClaudeSubscriptionConnectedServiceAuth.ts`, `apps/cli/src/backends/claude/connectedServices/materializeClaudeConnectedServiceAuth.ts`, `apps/cli/src/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn.ts` | Claude supports `claude-subscription` setup-token or OAuth materialization plus plain Anthropic API keys; Anthropic OAuth is intentionally rejected for the raw `anthropic` service. | Normalize Claude auth materialization as a declared env contract so runtime spawn, cloud connect, and connected-services stop looking like separate auth systems. |
| Automated provider tests / probes | `supported` | `apps/cli/src/backends/claude/e2e/providerSpec.json`, `apps/cli/src/backends/claude/e2e/providerScenarios.json`, `apps/cli/src/backends/claude/claudeRemoteLauncher.integration.test.ts`, `apps/cli/src/backends/claude/claudeLocalLauncher.integration.test.ts`, `apps/cli/src/backends/claude/executionRuns/claudeSdkExecutionRunSidechain.integration.test.ts`, `packages/tests/suites/providers/claude.agentTeams.subagents.jsonl.realProbe.test.ts` | Coverage spans launcher/runtime tests, direct-session tests, execution-run sidechains, provider scenario catalog, and real Claude provider probes for agent teams/subagent JSONL behavior. | Reorganize around shared provider-capability fixtures so local, remote, execution-run, and team-sidechain coverage reuse the same contracts. |
| Manual QA trackers and UI validation surfaces | `supported` | `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_TRACKER_2026-03-01.md`, `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_TRACKER_DETAILED_2026-03-01.md`, `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_TRACKER_E2E_2026-03-01.md`, `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_LIVE_TRACKER_2026-03-01.md`, `apps/ui/sources/components/sessions/runs/launcher/SessionExecutionRunLauncherView.tsx`, `apps/ui/sources/agents/providers/claude/sessionSubagents/ClaudeAgentLaunchActionsCard.tsx` | The March 2026 tracker set already audited Claude teams/swarms, participant routing, structured `participant_message.v1` rendering, and execution-run recipient behavior; those docs are the authoritative manual-QA evidence surface today. | Convert the tracker scenarios into a provider-agnostic QA checklist so Claude-specific manual evidence can map directly onto the future unified capability matrix. |

## Cross-cutting migration themes

1. Claude still has three materially different runtime shapes: local TUI, Agent SDK remote, and legacy remote shim. The unified architecture should make transport and control-plane differences internal, not user-visible.
2. Session identity is fragmented across `claudeSessionId`, `claudeTranscriptPath`, `directSessionV1`, and `externalHistoryImportV1`. Browse, wake, takeover, and handoff all reconstruct the same source tuple differently.
3. Claude subagent/team behavior is split between CLI-side collectors (`TaskOutput`, JSONL followers, team inbox) and UI-side participant derivation. Those lifecycle rules should live in one normalized sidechain model.
4. Execution runs already use Claude SDK semantics, but through a separate backend (`ClaudeSdkAgentBackend`) instead of the normal remote-session runtime. That is the clearest remaining duplication inside the Claude stack.
5. Claude provider settings still carry a migration seam of their own (`claudeRemoteSettingSources` legacy v1 plus `claudeRemoteSettingSourcesV2`). The future control plane should publish one settings schema and one live capability surface.
