# Firefly Video Compatibility Evidence

## Baseline

- Repository: `https://github.com/mei-ou/Firefly.git`
- Branch selected for the deployed syntax baseline: `test`
- Commit: `25006af903b9ef067963981ac51cb39aae431036`
- Firefly: `6.15.8`
- Astro: `7.2.0`

The pinned repository has no dedicated video Markdown plugin, provider registry, iframe sanitizer, or player component. Video examples are raw HTML passed through Astro's Markdown pipeline.

## Real Source Syntax

Only one pinned article contains deployed video iframe source: `src/content/posts/video.md`. It provides one YouTube example and one Bilibili example.

The deployed YouTube source is:

```html
<iframe width="100%" height="468" src="https://www.youtube.com/embed/5gIf0_xpFPI?si=N1WTorLKL0uwLsU_" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
```

The deployed Bilibili source is:

```html
<iframe width="100%" height="468" src="//player.bilibili.com/player.html?bvid=BV1fK4y1s7Qf&p=1&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" &autoplay=0> </iframe>
```

No deployed Vimeo, Tencent Video, native `<video>`, or other provider source was found. The article's prose says users may copy embed code from YouTube or another platform, but that sentence is not a provider allowlist or security policy.

## Firefly Processing And Styling

The active Markdown configuration enables dangerous HTML through the remark-to-rehype bridge and then parses it with `rehype-raw`. It does not configure `rehype-sanitize`. Pinned processor probes showed that iframe elements and attributes pass through rather than being normalized into a controlled video model.

The only article-level iframe styling found is generic:

```stylus
iframe
  display: block
  border-radius: 0.75rem
  margin: 1.25rem auto
  max-width: 100%
```

The pinned deployment configuration includes `X-Frame-Options: SAMEORIGIN`, but no `Content-Security-Policy`, `frame-src`, or `child-src` directive was found. `X-Frame-Options` controls whether other sites may frame Firefly; it does not restrict which third-party frames a Firefly article may load.

## Raw HTML Safety Finding

A Firefly-renderable iframe is not necessarily safe for the Admin editor. Pinned local probes established that the Firefly Markdown pipeline also preserves:

- `javascript:` iframe sources;
- `onload` event handlers;
- `srcdoc` containing script markup;
- arbitrary `style` and `sandbox` attributes;
- credential-bearing URLs;
- plain HTTP URLs;
- unknown hosts.

The Bilibili article example also has two compatibility hazards:

1. its source is protocol-relative instead of explicit HTTPS;
2. it contains a malformed standalone `&autoplay=0` attribute after `allowfullscreen`.

These findings prohibit using Firefly's general raw-HTML acceptance as an Admin allowlist.

## Admin YouTube Candidate

The first evidenced serializer candidate is intentionally narrower than the historical article source:

```html
<iframe width="100%" height="468" src="https://www.youtube.com/embed/VIDEO_ID" title="YouTube video player" frameborder="0" allowfullscreen></iframe>
```

The candidate requires:

- exact HTTPS host `www.youtube.com`;
- exact path `/embed/VIDEO_ID`;
- a validated YouTube video ID;
- no URL credentials;
- no query or fragment;
- the exact fixed attribute set and values above;
- an explicit closing tag.

The historical `si` query and broad `allow` attribute remain source-compatible evidence, but they are not necessary for the fixed candidate and therefore remain opaque when encountered. An untouched historical iframe must preserve its complete original source slice.

This candidate is suitable for the isolated codec and serializer spike. Production enablement still depends on the later video-specific implementation gate and tests; it does not authorize rendering an iframe in Admin.

## Bilibili Template Boundary

An equivalent-looking explicit HTTPS source passes through the pinned local Markdown processor:

```html
<iframe width="100%" height="468" src="https://player.bilibili.com/player.html?bvid=BV1fK4y1s7Qf&p=1&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>
```

That result proves only that Firefly accepts the string as raw HTML. It does not prove that the deployed Bilibili player accepts the HTTPS URL and query with equivalent behavior. Establishing that fact would require a third-party request or deployment-level evidence, which is intentionally outside this offline, no-third-party-request editor gate.

Therefore:

- the historical protocol-relative and malformed Bilibili iframe is known-but-opaque;
- the exact official protocol-relative template is recognized as an inert Admin placeholder;
- the cleaned HTTPS candidate remains blocked because it is not the documented template and its
  deployed equivalence is unverified;
- Admin never silently rewrites historical source bytes.

## Admin V0 Contract

Video handling stays isolated from general Markdown preview:

- users enter a supported public video page URL, never iframe HTML;
- a pure provider parser extracts and validates an ID from exact allowed hosts and paths;
- a provider serializer emits one fixed Markdown iframe source slice;
- Markdown remains the only persisted source of truth;
- the visual editing canvas displays a local inert placeholder with provider and normalized link;
- the placeholder creates no iframe, performs no playback, and makes no third-party request;
- it does not fetch a thumbnail, title, author, duration, or oEmbed metadata;
- the existing general Markdown preview continues to forbid iframe elements;
- unknown hosts, HTTP, credentials, IP literals, unconfirmed queries, autoplay, event attributes, `srcdoc`, style, arbitrary sandbox tokens, duplicate attributes, and malformed HTML fail closed into opaque source slices;
- untouched recognized or opaque source preserves its exact bytes;
- canonical serialization is allowed only after an explicit edit of an enabled structured node.

Recognition is a strict compatibility decision, not HTML sanitization. The codec must compare parsed structure with a provider's exact fixed template and must never execute or mount the source.

## Evidence Sources

- `src/content/posts/video.md:10-27`
- `astro.config.mjs` raw HTML configuration and plugin order
- `src/styles/markdown-extend.styl` iframe styles
- `vercel.json` response headers
- pinned local Astro Markdown processor probes for YouTube, Bilibili, and dangerous iframe variants
- `firefly-admin/src/components/articles/markdown-preview.ts` iframe prohibition
- `outputs/03-firefly-admin-visual-editor-agent-prompt.md:466-524`
