import type {
	AdminCapabilityKey,
	AdminCapabilityReleaseState,
	AdminCapabilitySnapshot,
} from "../../types/capability";
import type { RuntimeEnv } from "../../types/env";
import { ApiError } from "../http/errors";

type CapabilityEnvKey = Extract<keyof RuntimeEnv, `FEATURE_${string}`>;

interface ConfigurableCapabilityDefinition {
	releaseState: "available" | "frozen";
	defaultEnabled: boolean;
	envKey: CapabilityEnvKey;
}

interface UnreleasedCapabilityDefinition {
	releaseState: "unreleased";
	defaultEnabled: false;
}

type CapabilityDefinition = ConfigurableCapabilityDefinition | UnreleasedCapabilityDefinition;

/**
 * 能力注册表是服务端唯一事实来源。未发布能力故意没有环境变量键，因此部署配置无法
 * 绕过代码发布状态；冻结能力则保留显式复验后重新启用的入口。
 */
export const ADMIN_CAPABILITY_DEFINITIONS = {
	articleLinks: {
		releaseState: "available",
		defaultEnabled: true,
		envKey: "FEATURE_ARTICLE_LINKS",
	},
	externalHttpsLinks: {
		releaseState: "available",
		defaultEnabled: true,
		envKey: "FEATURE_EXTERNAL_HTTPS_LINKS",
	},
	smallImageUpload: {
		releaseState: "available",
		defaultEnabled: true,
		envKey: "FEATURE_SMALL_IMAGE_UPLOAD",
	},
	coverManagement: {
		releaseState: "available",
		defaultEnabled: true,
		envKey: "FEATURE_COVER_MANAGEMENT",
	},
	articleDelete: {
		releaseState: "available",
		defaultEnabled: true,
		envKey: "FEATURE_ARTICLE_DELETE",
	},
	pdfAttachmentUpload: {
		releaseState: "frozen",
		defaultEnabled: false,
		envKey: "FEATURE_PDF_ATTACHMENT_UPLOAD",
	},
	articleAssetDetails: {
		releaseState: "frozen",
		defaultEnabled: false,
		envKey: "FEATURE_ARTICLE_ASSET_DETAILS",
	},
	articleAssetRename: {
		releaseState: "frozen",
		defaultEnabled: false,
		envKey: "FEATURE_ARTICLE_ASSET_RENAME",
	},
	repositoryBrowser: { releaseState: "unreleased", defaultEnabled: false },
	crossArticleAssetMove: { releaseState: "unreleased", defaultEnabled: false },
	articleAssetReplace: { releaseState: "unreleased", defaultEnabled: false },
	singleAssetDelete: { releaseState: "unreleased", defaultEnabled: false },
} as const satisfies Record<AdminCapabilityKey, CapabilityDefinition>;

function parseOptionalBoolean(value: unknown, defaultValue: boolean): boolean {
	if (value === undefined) return defaultValue;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new ApiError(503, "CONFIGURATION_ERROR", "服务暂时不可用。");
}

export function resolveAdminCapabilities(
	env: Pick<RuntimeEnv, Extract<keyof RuntimeEnv, `FEATURE_${string}`>>,
): AdminCapabilitySnapshot {
	const snapshot = {} as Record<AdminCapabilityKey, boolean>;
	for (const [key, definition] of Object.entries(ADMIN_CAPABILITY_DEFINITIONS) as Array<
		[AdminCapabilityKey, CapabilityDefinition]
	>) {
		snapshot[key] =
			definition.releaseState === "unreleased"
				? false
				: parseOptionalBoolean(env[definition.envKey], definition.defaultEnabled);
	}
	return Object.freeze(snapshot);
}

export function requireAdminCapability(
	env: Pick<RuntimeEnv, Extract<keyof RuntimeEnv, `FEATURE_${string}`>>,
	capability: AdminCapabilityKey,
): void {
	if (!resolveAdminCapabilities(env)[capability]) {
		// 与模块开关保持一致：关闭能力返回 404，避免外部枚举内部实现。
		throw new ApiError(404, "NOT_FOUND", "资源不存在。");
	}
}

export function getAdminCapabilityReleaseState(
	capability: AdminCapabilityKey,
): AdminCapabilityReleaseState {
	return ADMIN_CAPABILITY_DEFINITIONS[capability].releaseState;
}
