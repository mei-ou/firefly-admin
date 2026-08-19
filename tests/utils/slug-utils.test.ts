import { describe, expect, it } from "vitest";
import {
	createSlugFromTitle,
	parseSlug,
	SLUG_MAX_LENGTH,
	validateSlug,
} from "../../src/utils/slug-utils";

describe("标题转 Firefly slug", () => {
	it("将中文标题转换为无声调拼音", () => {
		expect(createSlugFromTitle("你好世界")).toBe("ni-hao-shi-jie");
	});

	it("正确处理常见多音词", () => {
		expect(createSlugFromTitle("重庆音乐银行")).toBe("chong-qing-yin-yue-yin-hang");
	});

	it("保留拉丁字母和数字并统一小写", () => {
		expect(createSlugFromTitle("Firefly 后台 Astro 7")).toBe("firefly-hou-tai-astro-7");
	});

	it("将 ü 拼音转换为 v", () => {
		expect(createSlugFromTitle("女绿")).toBe("nv-lv");
	});

	it("压缩空白、标点和连续分隔符", () => {
		expect(createSlugFromTitle("  C++：Astro---博客！！！ ")).toBe("c-astro-bo-ke");
	});

	it("移除英文缩写撇号而不是拆词", () => {
		expect(createSlugFromTitle("What's New")).toBe("whats-new");
	});

	it("无法生成安全字符时返回空字符串交给校验层拒绝", () => {
		expect(createSlugFromTitle("🎉✨")).toBe("");
	});

	it("NFKC 归一化全角标题后再生成", () => {
		expect(createSlugFromTitle("Ｆｉｒｅｆｌｙ １２３")).toBe("firefly-123");
	});
});

describe("slug 安全校验", () => {
	it("接受规范小写 slug", () => {
		expect(validateSlug("firefly-admin-2026")).toEqual({
			valid: true,
			slug: "firefly-admin-2026",
		});
		expect(parseSlug("firefly-admin-2026")).toBe("firefly-admin-2026");
	});

	it("拒绝空值、非字符串和超过长度上限", () => {
		expect(validateSlug(123)).toMatchObject({ valid: false });
		expect(validateSlug("")).toEqual({ valid: false, reason: "empty" });
		expect(validateSlug("a".repeat(SLUG_MAX_LENGTH + 1))).toEqual({
			valid: false,
			reason: "too-long",
		});
	});

	it("拒绝大小写、空白、下划线和不规范连字符", () => {
		for (const slug of ["Firefly", "fire fly", "fire_fly", "-firefly", "firefly-", "fire--fly"]) {
			expect(validateSlug(slug), slug).toMatchObject({ valid: false });
		}
	});

	it("拒绝路径分隔符与穿越片段", () => {
		for (const slug of ["../admin", "admin/child", "admin\\child", "admin..child"]) {
			expect(validateSlug(slug), slug).toEqual({ valid: false, reason: "unsafe-input" });
		}
	});

	it("拒绝百分号编码形式", () => {
		for (const slug of ["%2e%2e", "admin%2fchild", "%5cwindows"]) {
			expect(validateSlug(slug), slug).toEqual({ valid: false, reason: "unsafe-input" });
		}
	});

	it("拒绝 NUL 和控制字符", () => {
		for (const slug of ["admin\u0000child", "admin\u001fchild", "admin\u007fchild"]) {
			expect(validateSlug(slug), slug).toEqual({ valid: false, reason: "unsafe-input" });
		}
	});

	it("拒绝全角和 Unicode 混淆值而不是静默改写", () => {
		for (const slug of ["ｆｉｒｅｆｌｙ", "firefly－admin", "fırefly", "fireﬂy"]) {
			expect(validateSlug(slug), slug).toMatchObject({ valid: false });
		}
	});

	it("parseSlug 的错误不回显恶意输入", () => {
		const malicious = "../../secret-token";
		expect(() => parseSlug(malicious)).toThrow("Slug 校验失败");
		try {
			parseSlug(malicious);
		} catch (error) {
			expect(String(error)).not.toContain(malicious);
		}
	});
});
