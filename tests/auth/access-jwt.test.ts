import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { AccessKeyResolver } from "../../src/core/auth/access-jwt";
import { verifyAccessJwt } from "../../src/core/auth/access-jwt";
import {
	createAccessJwtFixture,
	testAudience,
	testIssuer,
	testKeyId,
	testNow,
	testRuntimeConfig,
} from "../fixtures/access-jwt";

let fixture: Awaited<ReturnType<typeof createAccessJwtFixture>>;
let keyResolver: AccessKeyResolver;

beforeAll(async () => {
	fixture = await createAccessJwtFixture();
	keyResolver = async (protectedHeader) => {
		if (protectedHeader.kid !== testKeyId) {
			throw new Error("Unknown kid");
		}
		return fixture.primary.publicKey;
	};
});

describe("Cloudflare Access JWT 验证", () => {
	it("接受合法 RS256 Access 断言", async () => {
		const token = await fixture.signAccessJwt();
		await expect(verifyAccessJwt(token, testRuntimeConfig, keyResolver, testNow)).resolves.toEqual({
			sub: "subject-1",
			email: "admin@example.com",
		});
	});

	it("允许白名单中的主体在没有邮箱时访问", async () => {
		const token = await new SignJWT({})
			.setProtectedHeader({ alg: "RS256", kid: testKeyId })
			.setSubject("allowed-subject")
			.setIssuer(testIssuer)
			.setAudience(testAudience)
			.setExpirationTime(Math.floor(testNow.getTime() / 1000) + 300)
			.sign(fixture.primary.privateKey);

		await expect(verifyAccessJwt(token, testRuntimeConfig, keyResolver, testNow)).resolves.toEqual({
			sub: "allowed-subject",
		});
	});

	it("拒绝缺失断言", async () => {
		await expect(
			verifyAccessJwt(undefined, testRuntimeConfig, keyResolver, testNow),
		).rejects.toMatchObject({
			status: 401,
			code: "AUTH_REQUIRED",
		});
	});

	it("拒绝非 RS256 算法", async () => {
		const secret = new TextEncoder().encode("a-test-secret-with-sufficient-length");
		const token = await new SignJWT({ email: "admin@example.com" })
			.setProtectedHeader({ alg: "HS256", kid: testKeyId })
			.setSubject("subject-1")
			.setIssuer(testIssuer)
			.setAudience(testAudience)
			.setExpirationTime(Math.floor(testNow.getTime() / 1000) + 300)
			.sign(secret);

		await expect(
			verifyAccessJwt(token, testRuntimeConfig, keyResolver, testNow),
		).rejects.toMatchObject({
			code: "AUTH_INVALID",
		});
	});

	it("拒绝缺失 kid", async () => {
		const token = await fixture.signAccessJwt({}, { includeKeyId: false });
		await expect(
			verifyAccessJwt(token, testRuntimeConfig, keyResolver, testNow),
		).rejects.toMatchObject({
			code: "AUTH_INVALID",
		});
	});

	it("拒绝未知 kid", async () => {
		const token = await new SignJWT({ email: "admin@example.com" })
			.setProtectedHeader({ alg: "RS256", kid: "unknown-key" })
			.setSubject("subject-1")
			.setIssuer(testIssuer)
			.setAudience(testAudience)
			.setExpirationTime(Math.floor(testNow.getTime() / 1000) + 300)
			.sign(fixture.primary.privateKey);

		await expect(
			verifyAccessJwt(token, testRuntimeConfig, keyResolver, testNow),
		).rejects.toMatchObject({
			code: "AUTH_INVALID",
		});
	});

	it("拒绝错误私钥签名", async () => {
		const token = await fixture.signAccessJwt({}, { privateKey: fixture.alternate.privateKey });
		await expect(
			verifyAccessJwt(token, testRuntimeConfig, keyResolver, testNow),
		).rejects.toMatchObject({
			code: "AUTH_INVALID",
		});
	});

	it("拒绝错误 issuer", async () => {
		const token = await fixture.signAccessJwt({ iss: "https://evil.cloudflareaccess.com" });
		await expect(
			verifyAccessJwt(token, testRuntimeConfig, keyResolver, testNow),
		).rejects.toMatchObject({
			code: "AUTH_INVALID",
		});
	});

	it("拒绝错误 audience", async () => {
		const token = await fixture.signAccessJwt({ aud: "wrong-audience" });
		await expect(
			verifyAccessJwt(token, testRuntimeConfig, keyResolver, testNow),
		).rejects.toMatchObject({
			code: "AUTH_INVALID",
		});
	});

	it("拒绝过期断言", async () => {
		const token = await fixture.signAccessJwt({ exp: Math.floor(testNow.getTime() / 1000) - 1 });
		await expect(
			verifyAccessJwt(token, testRuntimeConfig, keyResolver, testNow),
		).rejects.toMatchObject({
			code: "AUTH_INVALID",
		});
	});

	it("拒绝缺失 exp 的断言", async () => {
		const token = await new SignJWT({ email: "admin@example.com" })
			.setProtectedHeader({ alg: "RS256", kid: testKeyId })
			.setSubject("subject-1")
			.setIssuer(testIssuer)
			.setAudience(testAudience)
			.sign(fixture.primary.privateKey);

		await expect(
			verifyAccessJwt(token, testRuntimeConfig, keyResolver, testNow),
		).rejects.toMatchObject({ code: "AUTH_INVALID" });
	});

	it("拒绝缺失 sub 的断言", async () => {
		const token = await new SignJWT({ email: "admin@example.com" })
			.setProtectedHeader({ alg: "RS256", kid: testKeyId })
			.setIssuer(testIssuer)
			.setAudience(testAudience)
			.setExpirationTime(Math.floor(testNow.getTime() / 1000) + 300)
			.sign(fixture.primary.privateKey);

		await expect(
			verifyAccessJwt(token, testRuntimeConfig, keyResolver, testNow),
		).rejects.toMatchObject({ code: "AUTH_INVALID" });
	});

	it("拒绝不在邮箱或主体白名单中的身份", async () => {
		const token = await fixture.signAccessJwt({
			email: "outsider@example.com",
			sub: "outsider-subject",
		});
		await expect(
			verifyAccessJwt(token, testRuntimeConfig, keyResolver, testNow),
		).rejects.toMatchObject({
			status: 403,
			code: "AUTH_FORBIDDEN",
		});
	});

	it("错误响应不泄露 JOSE 或密钥选择细节", async () => {
		const token = await fixture.signAccessJwt({}, { privateKey: fixture.alternate.privateKey });
		await expect(
			verifyAccessJwt(token, testRuntimeConfig, keyResolver, testNow),
		).rejects.toMatchObject({
			message: "Cloudflare Access 身份凭证无效。",
		});
	});
});
