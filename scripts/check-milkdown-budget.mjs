import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const clientDirectory = join(process.cwd(), "dist", "client", "_astro");
const budgetBytes = 400 * 1024;
const dynamicPrefixes = [
	"core.",
	"commonmark.",
	"gfm.",
	"history.",
	"listener.",
	"bridge.",
	"firefly-source-node.",
	"lib.",
	"w3c-keyname.",
];

let files;
try {
	files = readdirSync(clientDirectory).filter((name) => name.endsWith(".js"));
} catch {
	throw new Error("找不到生产客户端构建产物，请先运行 pnpm build。");
}

const articleEditor = files.find((name) => name.startsWith("ArticleEditor."));
if (!articleEditor) throw new Error("生产构建缺少 ArticleEditor 客户端 chunk。");

const articleEditorSource = readFileSync(join(clientDirectory, articleEditor), "utf8");
for (const prefix of dynamicPrefixes.slice(0, 7)) {
	if (!articleEditorSource.includes(`./${prefix}`)) {
		throw new Error(`ArticleEditor 未引用预期的 Milkdown 动态 chunk：${prefix}`);
	}
}

const dynamicFiles = files.filter((name) =>
	dynamicPrefixes.some((prefix) => name.startsWith(prefix)),
);
if (dynamicFiles.length === 0) throw new Error("未找到 Milkdown 动态 chunk。");

let rawBytes = 0;
let gzipBytes = 0;
for (const name of dynamicFiles) {
	const source = readFileSync(join(clientDirectory, name));
	rawBytes += source.byteLength;
	gzipBytes += gzipSync(source, { level: 9 }).byteLength;
}

console.log(
	`Milkdown 动态加载闭包：${(rawBytes / 1024).toFixed(1)} KiB 原始，${(gzipBytes / 1024).toFixed(1)} KiB gzip -9，${dynamicFiles.length} 个文件。`,
);
if (gzipBytes > budgetBytes) {
	throw new Error(
		`Milkdown 动态加载闭包超过 400 KiB gzip 预算：${(gzipBytes / 1024).toFixed(1)} KiB。`,
	);
}
