import type { AdminModule } from "../../types/module";

/**
 * 图床外链 URL 由 PUBLIC_IMGBED_URL 提供（CloudFlare Pages / wrangler 在构建时
 * 把 PUBLIC_* 注入前端 bundle）。图床 URL 本身不是 Secret，反而必须对用户公开，
 * 否则 target="_blank" 跳转也无法生效——所以走 PUBLIC_* 而非 Worker Secret。
 *
 * 失败关闭：必须是合法 https:// URL，缺失或不合规则归一化为 ""，对应导航降级为
 * 灰态"图床未配置"，避免被恶意/错配 URL 利用为开放重定向。任何抛错都要被吞掉
 * 转为空字符串，因为本模块在 SSR 构建期就会被求值，不能让导航崩溃。
 */
function resolveImgbedUrl(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const trimmed = raw.trim();
	if (!trimmed) return "";
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "https:") return "";
		// 规整化：去掉尾部斜杠、保证返回字符串可作为 href 直接使用。
		return parsed.toString();
	} catch {
		return "";
	}
}

const imgbedUrl = resolveImgbedUrl(import.meta.env.PUBLIC_IMGBED_URL);

export const mediaModule = {
	id: "media",
	navigation: {
		label: "媒体",
		description: imgbedUrl ? "跳转外部图床" : "图床未配置",
		icon: "image",
		order: 30,
	},
	routes: [{ path: "/media" }],
	permissions: ["media.read", "media.upload"],
	// 空字符串 = 已声明外链但 URL 未配置或不是 https，导航渲染为灰态禁用入口。
	externalUrl: imgbedUrl,
} as const satisfies AdminModule;