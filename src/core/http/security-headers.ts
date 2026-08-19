/**
 * P0 的最低安全响应头集合。
 * CSP 按当前同源静态资源最小放行；style-src 暂时允许内联样式以兼容 Astro/Svelte
 * 构建输出，后续引入编辑器时必须重新审计，不能扩大为通配来源或 unsafe-eval。
 */
export const securityHeaders = {
	"Content-Security-Policy": [
		"default-src 'self'",
		"base-uri 'none'",
		"connect-src 'self'",
		"font-src 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"img-src 'self' data:",
		"object-src 'none'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
	].join("; "),
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
} as const;

function createResponseWithHeaders(
	response: Response,
	headers: Headers,
	body: BodyInit | null = response.body,
): Response {
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function applyBaseSecurityHeaders(headers: Headers): void {
	for (const [name, value] of Object.entries(securityHeaders)) {
		headers.set(name, value);
	}
}

export function applySecurityHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	applyBaseSecurityHeaders(headers);
	return createResponseWithHeaders(response, headers);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

async function createInlineScriptHashes(html: string): Promise<string[]> {
	const hashes = new Set<string>();
	const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
	for (const match of scripts) {
		const attributes = match[1] ?? "";
		const source = match[2] ?? "";
		if (/\bsrc\s*=/i.test(attributes) || source.length === 0) continue;
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
		hashes.add(`'sha256-${bytesToBase64(new Uint8Array(digest))}'`);
	}
	return [...hashes];
}

/**
 * Astro 的客户端 Island 需要少量内联启动脚本。固定 `script-src 'self'` 会阻止这些脚本，
 * 但放宽为 `unsafe-inline` 会扩大 XSS 面；因此仅对当前 HTML 中精确匹配的脚本生成 CSP Hash。
 * 外部脚本仍只能同源，脚本内容变化后旧 Hash 自动失效，production 与本地开发使用同一边界。
 */
export async function applyDocumentSecurityHeaders(response: Response): Promise<Response> {
	const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
	if (!contentType.startsWith("text/html")) return applySecurityHeaders(response);

	const html = await response.text();
	const headers = new Headers(response.headers);
	applyBaseSecurityHeaders(headers);
	const hashes = await createInlineScriptHashes(html);
	if (hashes.length > 0) {
		const csp = securityHeaders["Content-Security-Policy"].replace(
			"script-src 'self'",
			`script-src 'self' ${hashes.join(" ")}`,
		);
		headers.set("Content-Security-Policy", csp);
	}
	return createResponseWithHeaders(response, headers, html);
}
