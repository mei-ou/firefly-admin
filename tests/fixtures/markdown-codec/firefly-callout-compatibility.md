# Firefly Callout Compatibility Evidence

## Baseline

- Repository: `https://github.com/mei-ou/Firefly.git`
- Branch selected for the deployed syntax baseline: `test`
- Commit: `25006af903b9ef067963981ac51cb39aae431036`
- Upstream base: `dd48f0b240aafd19ebba0b4e0812de3cc23be75a`
- Theme: `github`

The two local commits after the upstream base only change site configuration, Wrangler configuration, and the category widget. They do not change the Markdown plugin chain, content schema, or article syntax.

## Supported Source Syntax

The deployed theme recognizes blockquote callouts whose first paragraph starts with one of these case-insensitive markers:

```markdown
> [!NOTE] Optional custom title
> Body

> [!TIP] Optional custom title
> Body

> [!IMPORTANT] Optional custom title
> Body

> [!WARNING] Optional custom title
> Body

> [!CAUTION] Optional custom title
> Body
```

The custom title is optional. When omitted, `rehype-callouts` supplies the title from the normalized type. The V0 editor must preserve the original source slice and show a semantic Callout placeholder; it must not render the generated HTML in the editing canvas.

## Plugin Order

The active Markdown processor is declared in `astro.config.mjs`:

1. `remarkAdmonitionToBlockquoteCallout` is conditionally inserted before the other remark plugins, but the current `enablePythonMarkdownAdmonitions` value is `false`, so it is absent.
2. `remarkMath`, reading-time, wiki-link, image-grid, excerpt, directive, sectionize, directive conversion, Mermaid, and PlantUML run afterward.
3. `rehypeKatex` runs first in the rehype phase.
4. `rehypeCallouts` runs next with the configured `github` theme.
5. Heading, code, diagram, figure, image, external-link, email, component, and autolink plugins run later.

## Final DOM Contract

For a recognized non-collapsible callout, `rehype-callouts@2.2.0` changes the blockquote to a themed container and sets:

- `data-callout="<normalized-type>"`
- `data-collapsible="false"`
- the package's default container, title, title icon/text, and content classes
- a generated fallback title when the source has no custom title

The exact element tags and class values come from the package's `github` theme configuration. Admin V0 does not depend on, copy, or execute this output DOM; it only records the contract as compatibility evidence.

## Styling Contract

- `src/layouts/Layout.astro` imports `@rehype-callouts-theme`.
- The Vite alias resolves that import to `rehype-callouts/theme/github` for the selected configuration.
- `src/styles/variables.styl` defines the five callout color tokens.
- `src/styles/markdown-extend.styl` retains legacy `.admonition` styling, but the active GitHub-theme output contract comes from the imported package theme.

## Rejected Or Opaque Inputs

The third-stage codec must not recognize these as current Firefly Callouts:

- ordinary blockquotes;
- unsupported type markers such as `[!DANGER]` under the current GitHub theme;
- Docusaurus `:::tip` fences shown only as examples for another theme;
- Python-Markdown `!!!` or `???` admonitions while the conversion flag is disabled;
- malformed or incomplete blockquotes.

These inputs remain ordinary supported Markdown when their syntax is ordinary Markdown, or become opaque when a later codec cannot safely classify them. No source is automatically repaired or converted merely because another Firefly theme could understand it.

## Real Fixture Sources

- `src/content/posts/markdown-extended.md:24-70`
- `src/content/posts/code-examples.md:331`
- `src/content/posts/encrypted-demo.md:33-42`
- `src/config/siteConfig.ts:199-208`
- `src/types/siteConfig.ts:143-149`
- `astro.config.mjs:267-332`
- `src/layouts/Layout.astro:34-37`
- `src/styles/variables.styl:66-70`
- `node_modules/rehype-callouts/package.json` (`2.2.0`, MIT)
- `node_modules/rehype-callouts/dist/index.js`
- `pnpm-lock.yaml` entries for `rehype-callouts@2.2.0` and `remark-admonition-to-blockquote-callout@1.0.0`
