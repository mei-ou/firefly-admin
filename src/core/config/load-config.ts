import { ApiError } from "../http/errors";
import { runtimeEnvSchema, type ValidatedRuntimeConfig } from "./config-schema";

/**
 * 在请求进入安全核心前加载并验证 Worker 环境配置。
 *
 * 输入保持为 unknown，只有通过 Schema 且至少配置一个授权主体后才返回业务层；
 * 错误响应刻意隐藏具体缺失项，防止外部调用者探测部署配置。
 */
export function loadRuntimeConfig(input: unknown): ValidatedRuntimeConfig {
	const result = runtimeEnvSchema.safeParse(input);

	if (!result.success) {
		// 安全关键配置不完整时必须失败关闭，不能把请求降级为匿名访问。
		throw new ApiError(503, "CONFIGURATION_ERROR", "服务暂时不可用。");
	}

	if (result.data.ACCESS_ALLOWED_EMAILS.length + result.data.ACCESS_ALLOWED_SUBJECTS.length === 0) {
		throw new ApiError(503, "CONFIGURATION_ERROR", "服务暂时不可用。");
	}

	return result.data;
}
