const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'EVENT_TITLE'];

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
    isProduction: env.NODE_ENV === 'production' || Boolean(env.VERCEL),
  };
}
