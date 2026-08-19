/**
 * 受控外部 URL 只会被写入文章，不由 Worker 代抓取。仍固定 HTTPS、无凭据和默认端口，
 * 避免协议混淆、凭据泄露及把异常服务端口带到正式站点访问链路。
 */
export function parseUncredentialedHttpsUrl(input: string, label: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new TypeError(`${label}格式无效。`);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port) {
		throw new TypeError(`${label}必须使用不含凭据和异常端口的 HTTPS 地址。`);
	}
	if (url.search) {
		// 第一版拒绝 query，避免把签名 URL、Token 或追踪凭据长期写入公开 Markdown。
		throw new TypeError(`${label}不能包含查询参数。`);
	}
	return url.href;
}
