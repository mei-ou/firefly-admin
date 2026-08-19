# Firefly Math Compatibility Evidence

## Baseline

- Repository: `https://github.com/mei-ou/Firefly.git`
- Branch selected for the deployed syntax baseline: `test`
- Commit: `25006af903b9ef067963981ac51cb39aae431036`
- Firefly: `6.15.8`
- Astro: `7.2.0`
- `remark-math`: `6.0.0`
- `rehype-katex`: `7.0.1`
- KaTeX: `0.18.1`

The local commits after upstream `dd48f0b240aafd19ebba0b4e0812de3cc23be75a` do not change the Markdown processor, KaTeX configuration, or article syntax.

## Real Article Syntax

The pinned repository has a dedicated real article at `src/content/posts/katex-math-example.md`. It establishes these deployed source forms.

Inline math uses a single dollar pair:

```markdown
欧拉公式 $e^{i\pi} + 1 = 0$。
```

Display math uses `$$` on separate delimiter lines:

```markdown
$$
\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}
$$
```

The article also proves support for matrices, `aligned`, limits, sums, common symbols, inline math inside GFM tables, and `\ce{...}` chemical equations.

## Plugin Order And Extensions

Firefly's unified Markdown processor runs:

1. `remarkMath` during the remark phase with default options. Therefore `singleDollarTextMath` remains `true`.
2. `rehypeKatex` first in the rehype phase, before Callouts and the remaining Firefly rehype plugins.
3. KaTeX receives the imported `katex` object after Firefly loads `katex/dist/contrib/mhchem.mjs`.
4. Article pages load `katex/dist/katex.min.css` through `KatexManager.astro`.
5. Firefly's browser script wraps `.katex-display` in `.katex-display-container` for horizontal scrolling, and `markdown.css` styles that container.

No client-side KaTeX rendering is required for normal article output: KaTeX HTML is produced during Markdown processing. The browser behavior only adds the overflow wrapper.

## Delimiter Boundaries

A minimal render against the pinned dependency tree established these boundaries:

- `$...$` creates inline math.
- Separate `$$` delimiter lines create display math.
- `$$E = mc^2$$` on one line is parsed as inline math, not display math.
- An unclosed single dollar remains ordinary Markdown text.
- `\$` escapes a literal currency dollar.
- Because single-dollar math is enabled, text such as `价格从 $5 到 $10` is parsed as math between the two dollar signs. The editor must preserve this behavior and may diagnose the ambiguity, but must not silently reinterpret or repair it.
- A fenced code block with the info string `math` is also rendered as display KaTeX by `rehype-katex`. No matching real article source was found, so it is recorded as plugin-compatible syntax rather than a repository-authored convention.

## KaTeX Output And Error Contract

For valid formulas, `rehype-katex` replaces math nodes with KaTeX-generated HTML and MathML. Firefly V0 Admin does not depend on or copy this generated DOM.

For invalid TeX inside valid math delimiters, `rehype-katex` records a VFile diagnostic and retries with `throwOnError: false`. The resulting document contains a `.katex-error` representation instead of failing the whole Markdown document. Admin should distinguish delimiter recognition from TeX validity and retain the source slice either way.

KaTeX's default `trust` value is `false`; Firefly does not override it. Potential HTML-producing commands such as `\href` and `\htmlClass` therefore do not create trusted anchors, classes, or arbitrary HTML. This reduces KaTeX-specific injection capability, but it does not change the separate raw HTML weakness documented in the Details evidence.

KaTeX still has broad layout commands and defaults `maxSize` to infinity. The visual editor must not render arbitrary TeX in its editing canvas. Resource limits for any future server-side or isolated preview must be designed separately before production integration.

## Admin V0 Contract

Math remains a source-preserving semantic placeholder in the visual editor:

- preserve the complete original delimiter and TeX source slice while untouched;
- classify inline and display source forms without invoking KaTeX;
- do not load KaTeX CSS or JavaScript in the editing canvas;
- do not insert KaTeX-generated HTML or MathML into the editor DOM;
- do not fetch remote resources or execute commands from TeX;
- show a diagnostic for invalid or ambiguous input without automatically repairing it;
- only serialize canonical source after the user edits a recognized math placeholder.

Malformed boundaries that cannot be classified safely remain opaque. Valid delimiters with invalid TeX may remain a recognized math placeholder carrying an error diagnostic because Firefly itself recognizes the math boundary and emits an error representation.

## Evidence Sources

- `src/content/posts/katex-math-example.md:11-91`
- `src/content/posts/encrypted-demo.md:44-67`
- `astro.config.mjs:17-18`
- `astro.config.mjs:267-332`
- `src/components/features/KatexManager.astro:1-4`
- `src/pages/posts/[...slug].astro:122-123`
- `src/layouts/Layout.astro:874-894`
- `src/styles/markdown.css:119-123`
- `node_modules/remark-math/readme.md:149-183`
- `node_modules/remark-math/lib/index.js`
- `node_modules/rehype-katex/lib/index.js:43-140`
- `node_modules/katex/dist/katex.mjs:164-225`
- `pnpm-lock.yaml` entries for `remark-math@6.0.0`, `rehype-katex@7.0.1`, and `katex@0.18.1`
