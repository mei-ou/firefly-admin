import GithubSlugger from "github-slugger";
import { Lexer, type Token, type Tokens } from "marked";

export interface ArticleHeadingTarget {
	depth: number;
	text: string;
	id: string;
}

const MAX_HEADING_TARGETS = 500;
const MAX_HEADING_TARGET_LENGTH = 500;

function collectInlineText(tokens: Token[] | undefined): string {
	if (!tokens) return "";
	return tokens
		.map((token) => {
			if (token.type === "image") return token.text;
			if ("tokens" in token && Array.isArray(token.tokens)) {
				return collectInlineText(token.tokens);
			}
			if ("text" in token && typeof token.text === "string") return token.text;
			return "";
		})
		.join("");
}

/**
 * Firefly 的 rehypeSlug 使用 `github-slugger` 为整篇文档中的 H1-H6 分配 ID。选择器使用
 * 同一个有状态 slugger 按全文顺序处理所有标题，避免重复标题或 `foo` / `foo-1` 占位碰撞
 * 时生成与主站不同的锚点。
 */
export function extractArticleHeadings(markdown: string): ArticleHeadingTarget[] {
	const source = markdown.length > 1_000_000 ? markdown.slice(0, 1_000_000) : markdown;
	const tokens = Lexer.lex(source, { gfm: true });
	const slugger = new GithubSlugger();
	const headings: ArticleHeadingTarget[] = [];

	for (const token of tokens) {
		if (headings.length >= MAX_HEADING_TARGETS) break;
		if (token.type !== "heading") continue;
		const heading = token as Tokens.Heading;
		const fullText = collectInlineText(heading.tokens).trim();
		if (!fullText) continue;
		const id = slugger.slug(fullText);
		if (heading.depth < 1 || heading.depth > 6 || !id) continue;
		const text = fullText.slice(0, MAX_HEADING_TARGET_LENGTH);
		// 主站 ID 不能为了 API 字段预算被重新截断，否则插入的 hash 将不再指向真实标题。
		if (id.length > MAX_HEADING_TARGET_LENGTH) continue;
		headings.push({ depth: heading.depth, text, id });
	}
	return headings;
}
