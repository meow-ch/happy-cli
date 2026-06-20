import type {
    CodexApprovalPolicy,
    CodexCollaborationMode,
    CodexPermissionProfile,
    CodexSandboxMode,
    PermissionMode,
    RuntimeAccessMode,
    RuntimeMode,
} from '@/api/types';

export interface CodexControlInput {
    runtimeMode?: RuntimeMode | null;
    accessMode?: RuntimeAccessMode | null;
    permissionMode?: PermissionMode | null;
    collaborationMode?: CodexCollaborationMode | null;
    permissionProfile?: CodexPermissionProfile | null;
    approvalPolicy?: CodexApprovalPolicy | null;
    sandboxMode?: CodexSandboxMode | null;
    model?: string | null;
    reasoningEffort?: string | null;
}

export interface ResolvedCodexExecutionPolicy {
    collaborationMode?: CodexCollaborationMode;
    permissionProfile?: string;
    approvalPolicy: CodexApprovalPolicy;
    sandboxMode?: CodexSandboxMode;
    model?: string;
    reasoningEffort?: string;
}

function approvalForLegacyMode(mode: PermissionMode): CodexApprovalPolicy {
    switch (mode) {
        case 'read-only':
            return 'never';
        case 'safe-yolo':
            return 'on-failure';
        case 'yolo':
        case 'bypassPermissions':
            return 'never';
        case 'acceptEdits':
            return 'on-request';
        case 'default':
        case 'plan':
        case 'auto':
        case 'dontAsk':
        default:
            return 'untrusted';
    }
}

function permissionProfileForLegacyMode(mode: PermissionMode): string {
    switch (mode) {
        case 'read-only':
            return ':read-only';
        case 'yolo':
        case 'bypassPermissions':
            return ':danger-full-access';
        case 'default':
        case 'safe-yolo':
        case 'acceptEdits':
        case 'plan':
        case 'auto':
        case 'dontAsk':
        default:
            return ':workspace';
    }
}

function permissionProfileForAccessMode(mode: RuntimeAccessMode): string {
    switch (mode) {
        case 'read-only':
            return ':read-only';
        case 'danger-full-access':
            return ':danger-full-access';
        case 'workspace-write':
        default:
            return ':workspace';
    }
}

export function resolveCodexExecutionPolicy(input: CodexControlInput): ResolvedCodexExecutionPolicy {
    const legacyMode = input.permissionMode ?? 'default';
    const explicitProfile = typeof input.permissionProfile === 'string' && input.permissionProfile.length > 0
        ? input.permissionProfile
        : undefined;
    const accessProfile = input.accessMode ? permissionProfileForAccessMode(input.accessMode) : undefined;
    const explicitSandbox = typeof input.sandboxMode === 'string' && input.sandboxMode.length > 0
        ? input.sandboxMode
        : undefined;

    return {
        collaborationMode: input.collaborationMode ?? input.runtimeMode ?? (legacyMode === 'plan' ? 'plan' : undefined),
        permissionProfile: explicitProfile ?? accessProfile ?? (explicitSandbox ? undefined : permissionProfileForLegacyMode(legacyMode)),
        approvalPolicy: input.approvalPolicy ?? approvalForLegacyMode(legacyMode),
        sandboxMode: explicitProfile ? undefined : explicitSandbox,
        model: input.model ?? undefined,
        reasoningEffort: input.reasoningEffort ?? undefined,
    };
}
