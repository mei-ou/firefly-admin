import { generateKeyPair, SignJWT } from "jose";
import { loadRuntimeConfig } from "../../src/core/config/load-config";

export const testNow = new Date("2026-08-12T00:00:00.000Z");
export const testIssuer = "https://team.cloudflareaccess.com";
export const testAudience = "test-access-audience";
export const testKeyId = "test-rsa-key";

export const testRuntimeConfig = loadRuntimeConfig({
	ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
	ACCESS_AUDIENCE: testAudience,
	ADMIN_ORIGIN: "https://admin.example.com",
	ACCESS_ALLOWED_EMAILS: "admin@example.com",
	ACCESS_ALLOWED_SUBJECTS: "allowed-subject",
	APP_ENV: "test",
});

/**
 * 每个测试进程生成临时 RSA 密钥，既能真实覆盖 JOSE 签名校验，也不会把固定私钥
 * 保存到仓库。公钥由可注入 resolver 返回，因此测试不依赖网络或 Cloudflare JWKS。
 */
export async function createAccessJwtFixture() {
	const primary = await generateKeyPair("RS256", { extractable: true });
	const alternate = await generateKeyPair("RS256", { extractable: true });

	async function signAccessJwt(
		claims: Record<string, unknown> = {},
		options: { includeKeyId?: boolean; privateKey?: CryptoKey } = {},
	): Promise<string> {
		const protectedHeader: { alg: "RS256"; kid?: string } = { alg: "RS256" };
		if (options.includeKeyId !== false) {
			protectedHeader.kid = testKeyId;
		}

		return new SignJWT({
			email: "admin@example.com",
			...claims,
		})
			.setProtectedHeader(protectedHeader)
			.setSubject(typeof claims.sub === "string" ? claims.sub : "subject-1")
			.setIssuer(typeof claims.iss === "string" ? claims.iss : testIssuer)
			.setAudience(typeof claims.aud === "string" ? claims.aud : testAudience)
			.setIssuedAt(Math.floor(testNow.getTime() / 1000) - 60)
			.setExpirationTime(
				typeof claims.exp === "number" ? claims.exp : Math.floor(testNow.getTime() / 1000) + 300,
			)
			.sign(options.privateKey ?? primary.privateKey);
	}

	return {
		primary,
		alternate,
		signAccessJwt,
	};
}
