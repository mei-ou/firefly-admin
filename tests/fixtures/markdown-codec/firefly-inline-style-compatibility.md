# Firefly Inline Style Compatibility Evidence

## Baseline

- Repository: `https://github.com/mei-ou/Firefly.git`
- Branch selected for the deployed syntax baseline: `test`
- Commit: `25006af903b9ef067963981ac51cb39aae431036`
- Firefly: `6.15.8`
- Astro: `7.2.0`

This evidence distinguishes three different facts that must not be conflated:

1. a syntax occurs in pinned Firefly article source;
2. a syntax happens to pass through the current plugin pipeline;
3. a syntax is safe and stable enough for an Admin structured editing contract.

Only the first and third together authorize an enabled toolbar format.

## Enabled Standard Marks

### Bold

Pinned articles use and document CommonMark strong emphasis:

```markdown
**粗体文本**
__粗体文本__
```

Admin may parse both delimiter forms as a structured bold mark. An untouched source slice retains its original delimiters; after the user edits the mark, canonical serialization may use `**text**`.

### Italic

Pinned articles use and document CommonMark emphasis:

```markdown
*斜体文本*
_斜体文本_
```

Admin may parse both forms as a structured italic mark. After an explicit edit, canonical serialization may use `*text*`.

### Strikethrough

The pinned tutorial uses GFM strikethrough:

```markdown
~~删除文本~~
```

Astro's Markdown processor enables `remark-gfm`, so this has both article and active processor evidence. It may be a structured mark with `~~text~~` as canonical output.

Escaped delimiters remain ordinary text, and nested standard marks follow CommonMark/GFM semantics rather than raw-HTML rules.

## Underline Is Blocked

No pinned `.md` or `.mdx` article uses a dedicated underline source such as:

```html
<u>text</u>
```

or:

```markdown
:u[text]
:underline[text]
```

Firefly article links are visually underlined by `.custom-md a` CSS. That underline belongs to link rendering and does not establish a free-text underline mark.

Both `<u>text</u>` and `:u[text]` can currently produce a `u` element because Firefly allows raw HTML and maps arbitrary directive names to HAST tags. This is pipeline compatibility only. There is no directive-name whitelist, dedicated underline plugin, article-body `u` contract, or real source evidence.

Therefore the underline toolbar action remains blocked. Existing raw HTML or directive forms are opaque and source-preserving.

## Body Highlight Is Blocked

No pinned article uses a canonical body highlight syntax. In particular:

- `==text==` remains literal text in the pinned processor;
- `<mark>text</mark>` can pass through as raw HTML but has no real article evidence;
- `:mark[text]` can become a `mark` element through the generic directive bridge but has no allowlisted contract;
- `.search-panel mark` styles search-result highlighting, not article-body authoring;
- Expressive Code line and text markers belong to fenced code metadata, not body text;
- `:spoiler[text]` is a real reveal-on-hover feature and must not be relabeled as highlight.

The body highlight toolbar action therefore remains blocked. Spoiler and code markers require their own dedicated node contracts if added later.

## Color And Font Size Are Blocked

No ordinary pinned Markdown article defines a canonical color or font-size syntax. Searches found no real article use of:

```html
<span style="color: ...">
<span style="font-size: ...">
<font color="..." size="...">
```

and no dedicated color or size directive.

Pinned MDX files do use Tailwind classes such as `text-red-500`, `text-xs`, `text-lg`, `text-4xl`, and arbitrary sizes such as `text-[0.65rem]`. That is trusted MDX/JSX presentation code, not the Admin article schema's `format: "md"` text-style protocol. The same MDX content also contains expressions and event handlers, so it cannot be safely reduced to Markdown color and size marks.

Raw `<span style>` and generic `:span[...]` directives can preserve arbitrary CSS. The generic directive bridge also preserves event attributes such as `onclick`. Pinned probes confirmed that these attributes reach the generated HTML. Firefly's article Markdown pipeline has no `rehype-sanitize` stage.

Therefore Admin must not generate or structurally recognize arbitrary color, font-size, style, class, or deprecated `font` elements. Existing forms remain opaque.

## Directive And Raw HTML Safety Finding

The active remark chain includes `remark-directive` followed by `parseDirectiveNode`. Except for separately handled admonition containers, the bridge:

1. accepts any directive name;
2. converts that name to a HAST tag;
3. copies directive attributes to HAST properties.

Pinned probes produced:

```html
<u>under</u>
<mark>highlight</mark>
<span style="color:red;font-size:32px">styled</span>
<span onclick="alert(1)" style="color:red">text</span>
```

The Astro Markdown processor also sets `allowDangerousHtml: true`, runs `rehype-raw`, and stringifies dangerous HTML. No `rehype-sanitize` plugin is configured for article pages.

Consequently, “Firefly renders it” cannot serve as an Admin safety or compatibility criterion. Arbitrary raw HTML, unknown directives, attributes, styles, classes, and MDX stay opaque.

## Admin V0 Contract

The evidence-derived support table is:

| Feature | Source contract | Admin V0 |
| --- | --- | --- |
| Bold | `**text**`, read-compatible `__text__` | enabled structured mark |
| Italic | `*text*`, read-compatible `_text_` | enabled structured mark |
| Strikethrough | `~~text~~` | enabled structured mark |
| Underline | no canonical source | blocked; HTML/directive opaque |
| Body highlight | no canonical source | blocked; HTML/directive opaque |
| Text color | no canonical Markdown source | blocked; style/class/MDX opaque |
| Font size | no canonical Markdown source | blocked; style/class/MDX opaque |
| Link underline | Markdown link plus Firefly CSS | model as link, not underline |
| Spoiler | `:spoiler[text]` | separate future node, not highlight |
| Code marker | fenced-code metadata | code-block-only, not body highlight |

Additional rules:

- preserve an untouched recognized source slice, including delimiter choice and escapes;
- canonicalize only after the user explicitly edits a recognized structured mark;
- never convert raw HTML, unknown directives, or MDX into safe-looking marks;
- never add `style`, arbitrary `class`, `on*`, or deprecated `font` output;
- keep blocked toolbar controls disabled or hidden with a clear diagnostic rather than inventing syntax;
- do not widen the general Markdown preview sanitizer to display these forms;
- any future color, size, underline, or highlight feature requires a Firefly-owned canonical syntax, finite token/value allowlist, parser/serializer tests, article-page sanitization decision, and deployed fixture evidence.

This conclusion intentionally overrides the earlier isolated editor prototype's provisional controlled markers: those prototype markers were architectural experiments, not evidence of Firefly production syntax, and must not enter the production codec until Firefly defines the source contract.

## Evidence Sources

- `src/content/spec/about.md:3-28`
- `src/content/posts/firefly.md:14-44`
- `src/content/posts/markdown-tutorial.md:700-743`
- `src/content/posts/markdown-tutorial.md:852-871`
- `src/content/posts/markdown-tutorial.md:949-1002`
- `src/content/posts/markdown-extended.md:246-253`
- `src/content/posts/mdx-example.mdx:40-56`
- `src/content/spec/friends.mdx:49-146`
- `src/plugins/remark-directive-rehype.js:33-97`
- `src/styles/markdown.css:3-53`
- `src/styles/main.css:327-365`
- `src/styles/main.css:510-527`
- `astro.config.mjs:267-332`
- `node_modules/@astrojs/markdown-remark/dist/index.js:34-108`
- pinned local processor probes for standard marks, raw HTML, directives, literal double equals, and event attributes
