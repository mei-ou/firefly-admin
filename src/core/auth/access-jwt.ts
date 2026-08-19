import { createRemoteJWKSet, decodeProtectedHeader, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { AuthenticatedPrincipal } from "../../types/env";
import type { ValidatedRuntimeConfig } from "../config/config-schema";
import { ApiError } from "../http/errors";
import { authorizePrincipal } from "./authorization";

export type AccessKeyResolver = JWTVerifyGetKey;

/**
 * 从受信任的 Team Domain 构造 Cloudflare Access JWKS 解析器。
 * Team Domain 只能来自服务端验证后的环境配置，禁止由客户端指定，以免形成 SSRF。
 */
export function createAccessKeyResolver(teamDomain: string): AccessKeyResolver {
	return createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
}

/**
 * 完整验证 Cloudflare Access 断言并返回最小化身份主体。
 *
 * 验证固定为 RS256，同时检查 kid、签名、issuer、audience、exp 和应用白名单；
 * keyResolver 与时钟可注入，以便测试所有失败分支而不访问真实 JWKS。
 */
export async function verifyAccessJwt(
	assertion: unknown,
	config: ValidatedRuntimeConfig,
	keyResolver: AccessKeyResolver = createAccessKeyResolver(config.ACCESS_TEAM_DOMAIN),
	now: Date = new Date(),
): Promise<AuthenticatedPrincipal> {
	if (typeof assertion !== "string" || assertion.length === 0) {
		throw new ApiError(401, "AUTH_REQUIRED", "需要 Cloudflare Access 身份凭证。");
	}

	try {
		const protectedHeader = decodeProtectedHeader(assertion);
		// 固定算法并要求 kid，阻断算法降级以及无法绑定 JWKS 公钥的断言。
		if (protectedHeader.alg !== "RS256" || !protectedHeader.kid) {
			throw new Error("Invalid protected header");
		}

		const { payload } = await jwtVerify(assertion, keyResolver, {
			algorithms: ["RS256"],
			issuer: `https://${config.ACCESS_TEAM_DOMAIN}`,
			audience: config.ACCESS_AUDIENCE,
			currentDate: now,
		});

		if (typeof payload.exp !== "number" || !Number.isInteger(payload.exp)) {
			throw new Error("Missing exp");
		}
		if (typeof payload.sub !== "string" || payload.sub.length === 0) {
			throw new Error("Missing sub");
		}
		if (payload.email !== undefined && typeof payload.email !== "string") {
			throw new Error("Invalid email");
		}

		const principal: AuthenticatedPrincipal = payload.email
			? { sub: payload.sub, email: payload.email }
			: { sub: payload.sub };
		return authorizePrincipal(principal, config);
	} catch (error) {
		if (error instanceof ApiError && error.code === "AUTH_FORBIDDEN") {
			throw error;
		}
		// 不把 JOSE/JWKS 细节返回客户端，避免泄露密钥选择与验证状态。
		throw new ApiError(401, "AUTH_INVALID", "Cloudflare Access 身份凭证无效。");
	}
}
