import { createClient } from '@supabase/supabase-js';
import { fromDbError } from './errors.js';

export function createDb(config) {
  return createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function callRpc(db, fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw fromDbError(error);
  return data;
}

export async function runQuery(request) {
  const { data, error } = await request;
  if (error) throw fromDbError(error);
  return data;
}
