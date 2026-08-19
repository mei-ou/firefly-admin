# Firefly Details Compatibility Evidence

## Baseline

- Repository: `https://github.com/mei-ou/Firefly.git`
- Branch selected for the deployed syntax baseline: `test`
- Commit: `25006af903b9ef067963981ac51cb39aae431036`
- Firefly: `6.15.8`
- Astro: `7.2.0`
- `@astrojs/markdown-remark`: `7.2.2`

The two local commits after upstream `dd48f0b240aafd19ebba0b4e0812de3cc23be75a` do not change the Markdown processor or article syntax.

## Real Source Syntax

The pinned repository contains article-level folding as raw HTML rather than a remark directive or a custom plugin syntax:

````markdown
<details>
<summary>点击展开 Obsidian 语法列表</summary>

```markdown
> [!NOTE] NOTE
> 通用的笔记块。
```
</details>
````

Equivalent blocks occur three times in `src/content/posts/markdown-extended.md`. The `summary` string in `src/plugins/remark-directive-rehype.js` is an admonition type name and is unrelated to the HTML `<summary>` element.

## Parser And Final DOM Contract

Astro's unified processor configures `remark-rehype` with `allowDangerousHtml: true`, then runs `rehype-raw` and `rehype-stringify` with dangerous HTML allowed. Firefly does not add `rehype-sanitize` to this article pipeline.

A minimal render against the pinned dependency tree established these rules:

1. `<details>` and `<summary>` survive as native HTML elements.
2. A blank line after `</summary>` lets the following body resume Markdown parsing.
3. Without that blank line, body Markdown remains literal text inside the raw HTML block.
4. Markdown inside the `<summary>` element is not parsed. For example, `**text**` remains literal summary text.
5. The boolean `open` attribute survives and makes the native Details element initially expanded.
6. Other raw attributes and raw child elements also survive because this pipeline has no sanitizer.

Firefly wraps article output in `.prose`, so general Tailwind Typography styles may affect native elements. The only Firefly-authored Details-related CSS found in `src/styles` is the global `summary:focus-visible` outline. There is no article-specific Details component, script, or dedicated Details stylesheet in the pinned source.

## Admin V0 Structured Subset

Firefly's ability to emit raw HTML is not an Admin security allowlist. The codec may expose a semantic Details placeholder only when all of these conditions hold:

- the outer element is exactly one `<details>` block;
- it has no attribute, or only the boolean `open` attribute;
- its first child is exactly one `<summary>` element with no attributes;
- the summary contains text only and is kept literal;
- a blank line separates `</summary>` from the Markdown body;
- the closing `</details>` boundary is present and unambiguous;
- no nested raw HTML that the codec cannot safely classify is present.

An untouched structured block must still retain its original source slice. The codec may serialize canonical Details syntax only after the user edits the semantic placeholder.

## Opaque And Unsafe Inputs

The V0 codec must retain the entire source slice as opaque, inert content when it encounters:

- `class`, `style`, `id`, `data-*`, `aria-*`, event handlers, or any other unaudited attribute;
- attributes on `<summary>`;
- `<script>`, `<iframe>`, embedded event handlers, or unclassified raw HTML children;
- a missing or duplicated `<summary>`;
- missing blank-line separation where body Markdown would not parse;
- missing, mismatched, or ambiguous closing tags;
- nested Details blocks until nesting is separately designed and tested.

Opaque means source preservation, not trusted rendering. The visual editor must show an inert source placeholder, must not insert the raw HTML into the editing DOM, and must not execute browser behavior from the source. Source mode may display the original Markdown text.

## Security Finding

The pinned Firefly article pipeline currently passes examples such as `onclick`, inline `style`, arbitrary `data-*`, and `<script>` through to final HTML. This is a compatibility fact and a security boundary, not a feature for Admin to reproduce. Production integration remains blocked until the save and preview paths define how trusted authorship and raw HTML are governed end to end.

## Evidence Sources

- `src/content/posts/markdown-extended.md:78-167`
- `src/content/posts/markdown-extended.md:177-199`
- `src/content/posts/markdown-extended.md:209-240`
- `src/plugins/remark-directive-rehype.js:4-31`
- `astro.config.mjs:267-332`
- `node_modules/@astrojs/markdown-remark/dist/index.js:34-108`
- `node_modules/@astrojs/markdown-remark/package.json` (`7.2.2`, MIT)
- `src/components/common/Markdown.astro:7-9`
- `src/styles/main.css:57-76`
- `package.json` (`firefly@6.15.8`, `astro@7.2.0`)
