import { describe, expect, it } from "vitest";
import {
	ADMIN_CAPABILITY_DEFINITIONS,
	getAdminCapabilityReleaseState,
	requireAdminCapability,
	resolveAdminCapabilities,
} from "../../src/core/config/capabilities";
import { adminCapabilityKeys } from "../../src/types/capability";

const unreleasedCapabilities = [
	"repositoryBrowser",
	"crossArticleAssetMove",
	"articleAssetReplace",
	"singleAssetDelete",
] as const;

describe("后台能力策略", () => {
	it("集中注册所有能力并生成完整默认快照", () => {
		expect(Object.keys(ADMIN_CAPABILITY_DEFINITIONS).sort()).toEqual(
			[...adminCapabilityKeys].sort(),
		);
		expect(resolveAdminCapabilities({})).toEqual({
			articleLinks: true,
			externalHttpsLinks: true,
			smallImageUpload: true,
			coverManagement: true,
			articleDelete: true,
			pdfAttachmentUpload: false,
			articleAssetDetails: false,
			articleAssetRename: false,
			repositoryBrowser: false,
			crossArticleAssetMove: false,
			articleAssetReplace: false,
			singleAssetDelete: false,
		});
	});

	it("available 能力可关闭，frozen 能力只能由严格 true 显式开启", () => {
		expect(
			resolveAdminCapabilities({
				FEATURE_ARTICLE_LINKS: "false",
				FEATURE_ARTICLE_DELETE: "false",
				FEATURE_PDF_ATTACHMENT_UPLOAD: "true",
				FEATURE_ARTICLE_ASSET_DETAILS: "true",
				FEATURE_ARTICLE_ASSET_RENAME: "true",
			}),
		).toMatchObject({
			articleLinks: false,
			articleDelete: false,
			pdfAttachmentUpload: true,
			articleAssetDetails: true,
			articleAssetRename: true,
		});
	});

	it.each(["1", "yes", "TRUE", " false "])("拒绝模糊布尔配置 %s", (value) => {
		expect(() => resolveAdminCapabilities({ FEATURE_ARTICLE_LINKS: value })).toThrow(
			expect.objectContaining({ status: 503, code: "CONFIGURATION_ERROR" }),
		);
	});

	it("未发布能力硬锁定且没有可配置环境键", () => {
		for (const capability of unreleasedCapabilities) {
			expect(getAdminCapabilityReleaseState(capability)).toBe("unreleased");
			expect("envKey" in ADMIN_CAPABILITY_DEFINITIONS[capability]).toBe(false);
			expect(resolveAdminCapabilities({})[capability]).toBe(false);
		}
	});

	it("关闭能力的服务端守卫返回 404", () => {
		expect(() => requireAdminCapability({}, "repositoryBrowser")).toThrow(
			expect.objectContaining({ status: 404, code: "NOT_FOUND" }),
		);
		expect(() => requireAdminCapability({}, "articleLinks")).not.toThrow();
	});
});
