import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";

const ALLOWED_TAGS = [
	"a",
	"blockquote",
	"br",
	"code",
	"del",
	"em",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"li",
	"ol",
	"p",
	"pre",
	"strong",
	"mark",
	"span",
	"table",
	"tbody",
	"td",
	"th",
	"thead",
	"tr",
	"u",
	"ul",
] as const;

const ALLOWED_ATTRIBUTES = ["href", "title", "style"] as const;
const ALLOWED_INLINE_STYLES = new Set([
	"font-size:0.875rem",
	"font-size:1rem",
	"font-size:1.25rem",
	"font-size:1.5rem",
	"color:#172033",
	"color:#dc2626",
	"color:#ea580c",
	"color:#2563eb",
	"color:#15803d",
	"color:#7e22ce",
]);
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderControlledHtml(value: string): string {
	if (/^<\/?(?:u|mark)>$/iu.test(value)) return value.toLowerCase();
	const spanStart = /^<span style="([^"]+)">$/iu.exec(value);
	if (spanStart && ALLOWED_INLINE_STYLES.has(spanStart[1] ?? "")) {
		return `<span style="${spanStart[1]}">`;
	}
	if (/^<\/span>$/iu.test(value)) return "</span>";
	return escapeHtml(value);
}

function isSafeLink(value: string): boolean {
	if (value.startsWith("#") || value.startsWith("/")) return !value.startsWith("//");
	try {
		return SAFE_LINK_PROTOCOLS.has(new URL(value).protocol);
	} catch {
		return false;
	}
}

/**
 * Marked 的链接渲染器是第一道协议白名单。危险目标降级为纯文本，避免依赖 DOM
 * 才能验证核心安全行为；DOMPurify 仍保留为浏览器端的纵深清洗边界。
 */
function renderLink(href: string, title: string | null, text: string): string {
	if (!isSafeLink(href)) return text;
	const safeHref = escapeHtml(href);
	const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
	const externalAttributes = /^https?:/i.test(href)
		? ' target="_blank" rel="noopener noreferrer nofollow"'
		: "";
	return `<a href="${safeHref}"${titleAttribute}${externalAttributes}>${text}</a>`;
}

export type SanitizeHtml = (
	dirty: string,
	config: {
		ALLOWED_TAGS: string[];
		ALLOWED_ATTR: string[];
		ALLOW_DATA_ATTR: boolean;
		ALLOW_ARIA_ATTR: boolean;
		FORBID_TAGS: string[];
		RETURN_TRUSTED_TYPE: false;
	},
) => string;

/**
 * 将 Markdown 转成“适合交给清洗器”的 HTML。所有用户可控原始 HTML、图片和危险链接
 * 已先降级；该函数保持纯计算，单元测试无需模拟完整浏览器 DOM。
 */
export function renderMarkdownForSanitization(markdown: string): string {
	const source = markdown.length > 1_000_000 ? markdown.slice(0, 1_000_000) : markdown;
	const renderer = new Renderer();
	// 只放行工具栏可生成的受控内联标签；其他原始 HTML 仍全部降级为文本。
	renderer.html = ({ text }) => renderControlledHtml(text);
	renderer.image = ({ text }) => escapeHtml(text);
	renderer.checkbox = ({ checked }) => (checked ? "[x] " : "[ ] ");
	renderer.link = ({ href, title, tokens }) =>
		renderLink(href, title ?? null, renderer.parser.parseInline(tokens));
	const parsed = marked.parse(source, {
		async: false,
		gfm: true,
		breaks: false,
		renderer,
	});
	return parsed;
}

/**
 * DOMPurify 是最终安全边界，必须在浏览器挂载后调用。可注入清洗函数只用于测试配置，
 * 生产路径始终使用当前窗口关联的 DOMPurify 实例。
 */
export function renderSafeMarkdown(
	markdown: string,
	sanitize: SanitizeHtml = DOMPurify.sanitize.bind(DOMPurify),
): string {
	return sanitize(renderMarkdownForSanitization(markdown), {
		ALLOWED_TAGS: [...ALLOWED_TAGS],
		ALLOWED_ATTR: [...ALLOWED_ATTRIBUTES],
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
		FORBID_TAGS: ["form", "iframe", "img", "math", "object", "svg", "template"],
		RETURN_TRUSTED_TYPE: false,
	});
}
