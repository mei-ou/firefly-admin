import { describe, expect, it, vi } from "vitest";
import { guardModule, listNavigationModules } from "../../src/core/config/feature-flags";
import { initializeProvider } from "../../src/providers/registry";

describe("模块功能开关", () => {
	it("导航只包含已启用模块", () => {
		const moduleIds = listNavigationModules().map((module) => module.id);
		expect(moduleIds).toContain("articles");
		expect(moduleIds).not.toContain("settings");
	});

	it("关闭模块的页面和 API 守卫返回 404", () => {
		expect(() => guardModule("settings")).toThrow(
			expect.objectContaining({ status: 404, code: "NOT_FOUND" }),
		);
	});

	it("启用模块通过守卫", () => {
		expect(() => guardModule("media")).not.toThrow();
	});

	it("关闭模块不执行 Provider 工厂", () => {
		const create = vi.fn(() => ({ id: "settings-provider" }));
		const provider = initializeProvider("settings", {
			id: "settings-provider",
			moduleId: "settings",
			create,
		});

		expect(provider).toBeUndefined();
		expect(create).not.toHaveBeenCalled();
	});

	it("启用模块可以初始化对应 Provider", () => {
		const create = vi.fn(() => ({ id: "media-provider" }));
		const provider = initializeProvider("media", {
			id: "media-provider",
			moduleId: "media",
			create,
		});

		expect(provider).toEqual({ id: "media-provider" });
		expect(create).toHaveBeenCalledOnce();
	});

	it("拒绝用其他模块的工厂初始化 Provider", () => {
		const create = vi.fn(() => ({ id: "wrong-provider" }));
		expect(
			initializeProvider("articles", {
				id: "wrong-provider",
				moduleId: "media",
				create,
			}),
		).toBeUndefined();
		expect(create).not.toHaveBeenCalled();
	});
});
