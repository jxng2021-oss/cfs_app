import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform(value => value === 'true');
const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  APP_ORIGIN: z.url({ protocol: /^https?$/ }).refine(value => new URL(value).origin === value, 'Use an exact origin'),
  SESSION_PEPPER: z.string().min(32),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),
  TRUST_PROXY: bool.default(false),
  COOKIE_SECURE: bool.optional(),
});

export type Config = ReturnType<typeof parseConfig>;

export function parseConfig(env: Record<string, unknown>) {
  const result = configSchema.safeParse(env);
  if (!result.success) throw new Error('Invalid configuration fields: ' + result.error.issues.map(issue => issue.path.join('.')).join(', '));
  const values = result.data;
  const https = values.APP_ORIGIN.startsWith('https://');
  const cookieSecure = values.COOKIE_SECURE ?? https;
  if (cookieSecure !== https) throw new Error('COOKIE_SECURE must match the APP_ORIGIN protocol');
  if (values.SESSION_IDLE_MINUTES > values.SESSION_ABSOLUTE_HOURS * 60) throw new Error('Idle timeout exceeds absolute timeout');
  return { ...values, COOKIE_SECURE: cookieSecure };
}

export async function loadEnvironment(env = process.env) {
  if (!env.SECRET_ID) return env;
  const client = new SecretsManagerClient({});
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: env.SECRET_ID }));
    const secret = z.object({
      DATABASE_URL: z.string().optional(),
      SESSION_PEPPER: z.string().optional(),
      BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),
      BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
    }).parse(JSON.parse(result.SecretString ?? '{}'));
    return { ...env, ...secret };
  } finally {
    client.destroy();
  }
}
