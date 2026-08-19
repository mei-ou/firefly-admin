export interface RateLimitResult {
	success: boolean;
}

export interface RateLimitBinding {
	limit(options: { key: string }): Promise<RateLimitResult>;
}

export interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
	first<T = unknown>(): Promise<T | null>;
}

export interface D1Database {
	prepare(query: string): D1PreparedStatement;
}

export interface R2PutResult {
	key: string;
	size: number;
	etag: string;
	version: string;
}

export interface R2ObjectBinding {
	key: string;
	size: number;
	etag: string;
	uploaded: Date;
	httpMetadata?: { contentType?: string };
	customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyBinding extends R2ObjectBinding {
	arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2ListResultBinding {
	objects: R2ObjectBinding[];
	truncated: boolean;
	cursor?: string;
}

export interface R2BucketBinding {
	put(
		key: string,
		value: ReadableStream | ArrayBuffer | ArrayBufferView | Blob,
		options?: {
			httpMetadata?: { contentType?: string };
			customMetadata?: Record<string, string>;
		},
	): Promise<R2PutResult>;
	get(key: string): Promise<R2ObjectBodyBinding | null>;
	list(options?: {
		limit?: number;
		prefix?: string;
		cursor?: string;
	}): Promise<R2ListResultBinding>;
	delete(key: string | string[]): Promise<void>;
}

export interface RuntimeEnv {
	APP_VERSION?: string;
	APP_ENV?: "development" | "test" | "production";
	LOCAL_PREVIEW?: string;
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUDIENCE?: string;
	ADMIN_ORIGIN?: string;
	ACCESS_ALLOWED_EMAILS?: string;
	ACCESS_ALLOWED_SUBJECTS?: string;
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
	MEDIA_STAGING_BUCKET?: R2BucketBinding;
	RATE_LIMITER?: RateLimitBinding;
}

export interface AuthenticatedPrincipal {
	sub: string;
	email?: string;
}
