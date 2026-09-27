const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'EVENT_TITLE'];
const TRUE_FLAGS = new Set(['1', 'true', 'yes', 'on']);

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name] || !env[name].trim());
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
  if (env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  return {
    supabaseUrl: env.SUPABASE_URL.trim(),
    supabaseSecretKey: env.SUPABASE_SECRET_KEY.trim(),
    adminPassword: env.ADMIN_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
    eventTitle: env.EVENT_TITLE.trim(),
    // Optional: Power Automate webhook trigger URL for confirmation emails. Empty = emails disabled.
    powerAutomateWebhookUrl: (env.POWER_AUTOMATE_WEBHOOK_URL ?? '').trim(),
    isProduction: env.NODE_ENV === 'production' || Boolean(env.VERCEL),
    maintenanceMode: TRUE_FLAGS.has((env.MAINTENANCE_MODE ?? '').trim().toLowerCase()),
  };
}
