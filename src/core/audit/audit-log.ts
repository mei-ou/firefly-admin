const SENSITIVE_KEYS = /authorization|cookie|jwt|token|secret|password|private.?key|body|content/i;

export interface AuditEvent {
	requestId: string;
	subject: string;
	action: string;
	outcome: "success" | "failure";
	timestamp: string;
	target?: string;
	errorCode?: string;
	rateLimited?: boolean;
	metadata?: Readonly<Record<string, unknown>>;
}

export type AuditWriter = (event: Readonly<Record<string, unknown>>) => void;

/**
 * 递归清除审计元数据中的认证材料、Secret、正文和密码类字段。
 * 采用键名白名单反向策略可覆盖 Provider 后续附加的嵌套 metadata。
 */
export function sanitizeAuditValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sanitizeAuditValue);
	}
	if (typeof value !== "object" || value === null) {
		return value;
	}

	const sanitized: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		sanitized[key] = SENSITIVE_KEYS.test(key) ? "[REDACTED]" : sanitizeAuditValue(entry);
	}
	return sanitized;
}

export function writeAuditEvent(event: AuditEvent, writer: AuditWriter = console.info): void {
	// 日志仅保存执行追踪元数据；正文、认证材料和 Secret 必须递归脱敏。
	writer(sanitizeAuditValue(event) as Readonly<Record<string, unknown>>);
}
