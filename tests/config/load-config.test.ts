import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/core/config/load-config";
import { ApiError } from "../../src/core/http/errors";

const validEnv = {
	ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
	ACCESS_AUDIENCE: "audience-tag",
	ADMIN_ORIGIN: "https://admin.example.com",
	ACCESS_ALLOWED_EMAILS: "Admin@Example.com, editor@example.com",
	ACCESS_ALLOWED_SUBJECTS: "subject-1",
	APP_ENV: "test",
};

/**
 * 配置测试重点验证失败关闭：任何安全关键值不合法时，调用方只能得到统一配置错误，
 * 而不是带着不完整配置继续处理受保护请求。
 */
describe("loadRuntimeConfig", () => {
	it("归一化邮箱和主体白名单", () => {
		const config = loadRuntimeConfig(validEnv);

		expect(config.ACCESS_ALLOWED_EMAILS).toEqual(["admin@example.com", "editor@example.com"]);
		expect(config.ACCESS_ALLOWED_SUBJECTS).toEqual(["subject-1"]);
	});

	it("拒绝缺失 Access Team Domain", () => {
		expect(() => loadRuntimeConfig({ ...validEnv, ACCESS_TEAM_DOMAIN: undefined })).toThrow(
			ApiError,
		);
	});

	it("拒绝非 Cloudflare Access Team Domain", () => {
		expect(() => loadRuntimeConfig({ ...validEnv, ACCESS_TEAM_DOMAIN: "example.com" })).toThrow(
			ApiError,
		);
	});

	it("拒绝带路径的后台 Origin", () => {
		expect(() =>
			loadRuntimeConfig({ ...validEnv, ADMIN_ORIGIN: "https://admin.example.com/path" }),
		).toThrow(ApiError);
	});

	it("拒绝空身份白名单", () => {
		expect(() =>
			loadRuntimeConfig({
				...validEnv,
				ACCESS_ALLOWED_EMAILS: "",
				ACCESS_ALLOWED_SUBJECTS: "",
			}),
		).toThrow(ApiError);
	});

	it("不要求 P0 只读启动时必须存在限流 Binding", () => {
		const config = loadRuntimeConfig(validEnv);
		expect(config.RATE_LIMITER).toBeUndefined();
	});
});
