import { z } from "zod";

const csvSchema = z.string().transform((value) =>
	value
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean),
);

export const runtimeEnvSchema = z.object({
	ACCESS_TEAM_DOMAIN: z
		.string()
		.trim()
		.min(1)
		.regex(/^[a-z0-9.-]+\.cloudflareaccess\.com$/i),
	ACCESS_AUDIENCE: z.string().trim().min(1),
	ADMIN_ORIGIN: z.url().refine((value) => new URL(value).origin === value),
	ACCESS_ALLOWED_EMAILS: csvSchema,
	ACCESS_ALLOWED_SUBJECTS: csvSchema,
	APP_ENV: z.enum(["development", "test", "production"]).default("production"),
	RATE_LIMITER: z
		.custom<{ limit(options: { key: string }): Promise<{ success: boolean }> }>(
			(value) =>
				typeof value === "object" &&
				value !== null &&
				typeof Reflect.get(value, "limit") === "function",
		)
		.optional(),
});

export type ValidatedRuntimeConfig = z.infer<typeof runtimeEnvSchema>;
