import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { writeAuditEvent } from "./core/audit/audit-log";
import { verifyAccessJwt } from "./core/auth/access-jwt";
import { resolveAdminCapabilities } from "./core/config/capabilities";
import { loadRuntimeConfig } from "./core/config/load-config";
import { normalizeError } from "./core/http/errors";
import { createRequestId } from "./core/http/request-context";
import { errorResponse } from "./core/http/response";
import { applyDocumentSecurityHeaders, applySecurityHeaders } from "./core/http/security-headers";
import {
	createLocalPreviewPrincipal,
	handleLocalPreviewApiRequest,
	isLocalPreviewRequest,
} from "./core/local-preview";
import { enforceWriteRequestPolicy } from "./core/security/origin-policy";

export const onRequest = defineMiddleware(async (context, next) => {
	const requestId = createRequestId(context.request);
	context.locals.requestId = requestId;

	try {
		// 页面和 API 共用同一服务端裁决快照；浏览器收到的副本只用于挂载 UI，不能反向授权。
		context.locals.capabilities = resolveAdminCapabilities({
			FEATURE_ARTICLE_LINKS: Reflect.get(env, "FEATURE_ARTICLE_LINKS") as unknown as string,
			FEATURE_EXTERNAL_HTTPS_LINKS: Reflect.get(
				env,
				"FEATURE_EXTERNAL_HTTPS_LINKS",
			) as unknown as string,
			FEATURE_SMALL_IMAGE_UPLOAD: Reflect.get(
				env,
				"FEATURE_SMALL_IMAGE_UPLOAD",
			) as unknown as string,
			FEATURE_COVER_MANAGEMENT: Reflect.get(env, "FEATURE_COVER_MANAGEMENT") as unknown as string,
			FEATURE_ARTICLE_DELETE: Reflect.get(env, "FEATURE_ARTICLE_DELETE") as unknown as string,
			FEATURE_PDF_ATTACHMENT_UPLOAD: Reflect.get(
				env,
				"FEATURE_PDF_ATTACHMENT_UPLOAD",
			) as unknown as string,
			FEATURE_ARTICLE_ASSET_DETAILS: Reflect.get(
				env,
				"FEATURE_ARTICLE_ASSET_DETAILS",
			) as unknown as string,
			FEATURE_ARTICLE_ASSET_RENAME: Reflect.get(
				env,
				"FEATURE_ARTICLE_ASSET_RENAME",
			) as unknown as string,
		});
		if (context.url.pathname !== "/api/health") {
			if (isLocalPreviewRequest(context.request, env)) {
				// 本地预览只在显式 development loopback 条件下成立，且使用内存 API fixture，
				// 不读取 Access、GitHub、D1 或 Rate Limiter 配置。
				context.locals.principal = createLocalPreviewPrincipal();
				const previewResponse = await handleLocalPreviewApiRequest(
					context.request,
					context.locals.capabilities,
				);
				if (previewResponse) {
					previewResponse.headers.set("X-Request-Id", requestId);
					return applySecurityHeaders(previewResponse);
				}
			} else {
				// Astro 6+ 通过 cloudflare:workers 暴露绑定；不再使用已移除的 locals.runtime.env。
				const config = loadRuntimeConfig(env);
				const writePolicy =
					context.request.method === "POST" && context.url.pathname === "/api/media/staging"
						? { contentTypes: ["multipart/form-data"] as const }
						: undefined;
				enforceWriteRequestPolicy(context.request, config.ADMIN_ORIGIN, writePolicy);
				context.locals.principal = await verifyAccessJwt(
					context.request.headers.get("Cf-Access-Jwt-Assertion"),
					config,
				);
			}
		}

		const response = await next();
		response.headers.set("X-Request-Id", requestId);
		return applyDocumentSecurityHeaders(response);
	} catch (error) {
		const normalized = normalizeError(error);
		writeAuditEvent({
			requestId,
			subject: context.locals.principal?.sub ?? "anonymous",
			action: `${context.request.method} ${context.url.pathname}`,
			outcome: "failure",
			errorCode: normalized.code,
			timestamp: new Date().toISOString(),
			rateLimited: normalized.code === "RATE_LIMITED",
		});
		return errorResponse(normalized, requestId);
	}
});
