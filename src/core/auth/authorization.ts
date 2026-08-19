import type { AuthenticatedPrincipal } from "../../types/env";
import type { ValidatedRuntimeConfig } from "../config/config-schema";
import { ApiError } from "../http/errors";

/**
 * 对已通过 JWT 密码学验证的主体执行应用级白名单授权。
 *
 * 签名有效只说明身份由 Cloudflare Access 签发，并不代表该身份有权管理博客，
 * 因此邮箱或稳定主体 ID 至少必须命中一项服务端白名单。
 */
export function authorizePrincipal(
	principal: AuthenticatedPrincipal,
	config: ValidatedRuntimeConfig,
): AuthenticatedPrincipal {
	const normalizedEmail = principal.email?.toLowerCase();
	const emailAllowed = normalizedEmail
		? config.ACCESS_ALLOWED_EMAILS.includes(normalizedEmail)
		: false;
	const subjectAllowed = config.ACCESS_ALLOWED_SUBJECTS.includes(principal.sub.toLowerCase());

	if (!emailAllowed && !subjectAllowed) {
		throw new ApiError(403, "AUTH_FORBIDDEN", "当前身份无权访问。");
	}

	return principal;
}
