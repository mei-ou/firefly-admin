import { FIREFLY_SYNTAX_BASELINE } from "./firefly-callout-fixtures";

export { FIREFLY_SYNTAX_BASELINE };

export type FireflyVideoDisposition = "blocked" | "opaque" | "structured";
export type FireflyVideoProvider = "bilibili" | "unknown" | "youtube";
export type FireflyVideoTemplateStatus = "blocked" | "enabled-candidate" | "not-applicable";

export interface FireflyVideoFixture {
	id: string;
	source: string;
	expected: {
		disposition: FireflyVideoDisposition;
		provider: FireflyVideoProvider;
		templateStatus: FireflyVideoTemplateStatus;
		videoId?: string;
		diagnostic: string;
	};
	sourceEvidence: string;
}

/**
 * This is the only currently evidenced Admin serializer candidate. It deliberately omits optional
 * query parameters and broad iframe permissions. The editor must store this exact Markdown source
 * rather than an iframe DOM node, and the editing canvas must never instantiate the iframe.
 */
export function buildYouTubeVideoSource(videoId: string): string {
	if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
		throw new Error("YouTube fixture video ID must use the evidenced 11-character form.");
	}

	return `<iframe width="100%" height="468" src="https://www.youtube.com/embed/${videoId}" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\n`;
}

export function buildBilibiliVideoSource(videoId: string): string {
	if (!/^BV[A-Za-z0-9]{10}$/.test(videoId)) {
		throw new Error("Bilibili fixture video ID must use the evidenced BV plus 10-character form.");
	}

	return `<iframe width="100%" height="468" src="//player.bilibili.com/player.html?bvid=${videoId}&p=1&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>\n`;
}

/**
 * Firefly passes raw iframe HTML through its Markdown pipeline, so successful Firefly rendering is
 * not a safety decision. Only the exact fixed YouTube and official Bilibili candidates are
 * structured here. Historical, dangerous, malformed, or deployment-unverified forms remain inert
 * source-preserving fixtures.
 */
export const FIREFLY_VIDEO_FIXTURES: readonly FireflyVideoFixture[] = [
	{
		id: "youtube-fixed-template-candidate",
		source: buildYouTubeVideoSource("5gIf0_xpFPI"),
		expected: {
			disposition: "structured",
			provider: "youtube",
			templateStatus: "enabled-candidate",
			videoId: "5gIf0_xpFPI",
			diagnostic:
				"Exact HTTPS host, embed path, video ID, and fixed attributes; no query or active preview.",
		},
		sourceEvidence: "video.md:19 plus pinned Firefly raw-HTML processor probe",
	},
	{
		id: "bilibili-official-fixed-template",
		source: buildBilibiliVideoSource("BV1fK4y1s7Qf"),
		expected: {
			disposition: "structured",
			provider: "bilibili",
			templateStatus: "enabled-candidate",
			videoId: "BV1fK4y1s7Qf",
			diagnostic:
				"Official protocol-relative Bilibili template with fixed player query and inert placeholder; no iframe is created.",
		},
		sourceEvidence: "Firefly 官方 writing.html 嵌入视频章节",
	},
	{
		id: "youtube-real-deployed-iframe",
		source:
			'<iframe width="100%" height="468" src="https://www.youtube.com/embed/5gIf0_xpFPI?si=N1WTorLKL0uwLsU_" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>\n',
		expected: {
			disposition: "opaque",
			provider: "youtube",
			templateStatus: "not-applicable",
			videoId: "5gIf0_xpFPI",
			diagnostic:
				"Real source evidence, but the unconfirmed si query and broader allow attribute are outside the fixed Admin template.",
		},
		sourceEvidence: "src/content/posts/video.md:23",
	},
	{
		id: "youtube-autoplay-query",
		source:
			'<iframe width="100%" height="468" src="https://www.youtube.com/embed/5gIf0_xpFPI?autoplay=1" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\n',
		expected: {
			disposition: "opaque",
			provider: "youtube",
			templateStatus: "not-applicable",
			videoId: "5gIf0_xpFPI",
			diagnostic: "Autoplay and every unconfirmed query parameter are forbidden.",
		},
		sourceEvidence: "Admin video safety boundary",
	},
	{
		id: "youtube-extra-style",
		source:
			'<iframe width="100%" height="468" style="border:0" src="https://www.youtube.com/embed/5gIf0_xpFPI" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\n',
		expected: {
			disposition: "opaque",
			provider: "youtube",
			templateStatus: "not-applicable",
			videoId: "5gIf0_xpFPI",
			diagnostic: "Inline style is outside the exact fixed attribute set.",
		},
		sourceEvidence: "Admin video safety boundary",
	},
	{
		id: "youtube-sandbox-attribute",
		source:
			'<iframe width="100%" height="468" sandbox="allow-scripts" src="https://www.youtube.com/embed/5gIf0_xpFPI" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\n',
		expected: {
			disposition: "opaque",
			provider: "youtube",
			templateStatus: "not-applicable",
			videoId: "5gIf0_xpFPI",
			diagnostic: "User-controlled sandbox tokens are outside the fixed template.",
		},
		sourceEvidence: "Admin video safety boundary",
	},
	{
		id: "bilibili-real-protocol-relative-malformed-iframe",
		source:
			'<iframe width="100%" height="468" src="//player.bilibili.com/player.html?bvid=BV1fK4y1s7Qf&p=1&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" &autoplay=0> </iframe>\n',
		expected: {
			disposition: "opaque",
			provider: "bilibili",
			templateStatus: "not-applicable",
			videoId: "BV1fK4y1s7Qf",
			diagnostic:
				"Real source evidence, but protocol-relative URL and malformed ampersand attribute cannot become an Admin template.",
		},
		sourceEvidence: "src/content/posts/video.md:27",
	},
	{
		id: "bilibili-https-template-candidate-blocked",
		source:
			'<iframe width="100%" height="468" src="https://player.bilibili.com/player.html?bvid=BV1fK4y1s7Qf&p=1&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>\n',
		expected: {
			disposition: "blocked",
			provider: "bilibili",
			templateStatus: "blocked",
			videoId: "BV1fK4y1s7Qf",
			diagnostic:
				"Firefly accepts the HTTPS source string, but deployed remote-player equivalence is not yet evidenced without a third-party request.",
		},
		sourceEvidence: "pinned Firefly raw-HTML processor probe; deployment evidence pending",
	},
	{
		id: "unknown-provider",
		source:
			'<iframe width="100%" height="468" src="https://videos.example.com/embed/abc" title="Video player" frameborder="0" allowfullscreen></iframe>\n',
		expected: {
			disposition: "opaque",
			provider: "unknown",
			templateStatus: "not-applicable",
			diagnostic: "The host has no pinned Firefly article and template evidence.",
		},
		sourceEvidence: "negative compatibility fixture",
	},
	{
		id: "http-youtube",
		source:
			'<iframe width="100%" height="468" src="http://www.youtube.com/embed/5gIf0_xpFPI" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\n',
		expected: {
			disposition: "opaque",
			provider: "youtube",
			templateStatus: "not-applicable",
			videoId: "5gIf0_xpFPI",
			diagnostic: "Only credential-free HTTPS URLs can enter a structured video node.",
		},
		sourceEvidence: "Admin URL safety boundary and pinned Firefly pass-through probe",
	},
	{
		id: "credentialed-youtube-url",
		source:
			'<iframe width="100%" height="468" src="https://user:password@www.youtube.com/embed/5gIf0_xpFPI" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\n',
		expected: {
			disposition: "opaque",
			provider: "youtube",
			templateStatus: "not-applicable",
			diagnostic: "URL credentials are forbidden even when the apparent host is allowed.",
		},
		sourceEvidence: "Admin URL safety boundary and pinned Firefly pass-through probe",
	},
	{
		id: "ip-literal-host",
		source:
			'<iframe width="100%" height="468" src="https://127.0.0.1/embed/5gIf0_xpFPI" title="Video player" frameborder="0" allowfullscreen></iframe>\n',
		expected: {
			disposition: "opaque",
			provider: "unknown",
			templateStatus: "not-applicable",
			diagnostic: "IP-literal iframe hosts are forbidden.",
		},
		sourceEvidence: "Admin URL safety boundary",
	},
	{
		id: "javascript-source-and-event-handler",
		source: '<iframe src="javascript:alert(1)" onload="alert(2)"></iframe>\n',
		expected: {
			disposition: "opaque",
			provider: "unknown",
			templateStatus: "not-applicable",
			diagnostic: "Active URL schemes and event-handler attributes are forbidden.",
		},
		sourceEvidence: "pinned Firefly pass-through probe",
	},
	{
		id: "srcdoc-script",
		source: '<iframe srcdoc="<script>alert(1)</script>"></iframe>\n',
		expected: {
			disposition: "opaque",
			provider: "unknown",
			templateStatus: "not-applicable",
			diagnostic: "srcdoc is executable iframe content and is never accepted.",
		},
		sourceEvidence: "pinned Firefly pass-through probe",
	},
	{
		id: "duplicate-source-attribute",
		source:
			'<iframe width="100%" height="468" src="https://www.youtube.com/embed/5gIf0_xpFPI" src="https://attacker.example/embed/x" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\n',
		expected: {
			disposition: "opaque",
			provider: "youtube",
			templateStatus: "not-applicable",
			diagnostic: "Duplicate attributes make the source ambiguous and must fail closed.",
		},
		sourceEvidence: "negative parser fixture",
	},
	{
		id: "missing-closing-tag",
		source:
			'<iframe width="100%" height="468" src="https://www.youtube.com/embed/5gIf0_xpFPI" title="YouTube video player" frameborder="0" allowfullscreen>\n',
		expected: {
			disposition: "opaque",
			provider: "youtube",
			templateStatus: "not-applicable",
			videoId: "5gIf0_xpFPI",
			diagnostic: "An incomplete raw-HTML element must remain an opaque source slice.",
		},
		sourceEvidence: "negative parser fixture",
	},
	{
		id: "native-video-element",
		source: '<video controls src="https://media.example.com/example.mp4"></video>\n',
		expected: {
			disposition: "opaque",
			provider: "unknown",
			templateStatus: "not-applicable",
			diagnostic: "No pinned Firefly native-video source or Admin serializer template exists.",
		},
		sourceEvidence: "negative compatibility fixture",
	},
];
