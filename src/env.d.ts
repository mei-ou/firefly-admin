/// <reference types="astro/client" />

import type { AdminCapabilitySnapshot } from "./types/capability";

declare global {
	interface RateLimitResult {
		success: boolean;
	}

	interface RateLimitBinding {
		limit(options: { key: string }): Promise<RateLimitResult>;
	}

	interface CloudflareEnv {
		APP_VERSION: string;
		APP_ENV: "development" | "test" | "production";
		LOCAL_PREVIEW?: string;
		ACCESS_TEAM_DOMAIN: string;
		ACCESS_AUDIENCE: string;
		ADMIN_ORIGIN: string;
		ACCESS_ALLOWED_EMAILS: string;
		ACCESS_ALLOWED_SUBJECTS: string;
		GITHUB_OWNER?: string;
		GITHUB_REPO?: string;
		GITHUB_BRANCH?: string;
		GITHUB_CONTENT_ROOT?: string;
		GITHUB_TOKEN?: string;
		PUBLIC_ARTICLE_URL_TEMPLATE?: string;
		FEATURE_ARTICLE_LINKS?: string;
		FEATURE_EXTERNAL_HTTPS_LINKS?: string;
		FEATURE_SMALL_IMAGE_UPLOAD?: string;
		FEATURE_COVER_MANAGEMENT?: string;
		FEATURE_ARTICLE_DELETE?: string;
		FEATURE_PDF_ATTACHMENT_UPLOAD?: string;
		FEATURE_ARTICLE_ASSET_DETAILS?: string;
		FEATURE_ARTICLE_ASSET_RENAME?: string;
		IDEMPOTENCY_DB?: D1Database;
		MEDIA_STAGING_BUCKET?: R2Bucket;
		RATE_LIMITER?: RateLimitBinding;
	}

	namespace App {
		interface Locals {
			requestId: string;
			capabilities: AdminCapabilitySnapshot;
			principal?: {
				sub: string;
				email?: string;
			};
		}
	}
}
