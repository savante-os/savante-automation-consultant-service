/**
 * Issue or revoke an invite-only MCP API key (Phase 1 — no signup UI).
 *
 * Issue prints the secret ONCE. Stores only key_prefix + sha256 hash.
 *
 *   npx tsx --env-file-if-exists=.env scripts/issue-mcp-key.ts --email you@example.com --name Cursor
 *
 * Revoke sets revoked_at on the caller's key(s):
 *
 *   npx tsx --env-file-if-exists=.env scripts/issue-mcp-key.ts --revoke --email you@example.com
 *   npx tsx --env-file-if-exists=.env scripts/issue-mcp-key.ts --revoke --email you@example.com --key-prefix sav_live_abcd1234
 *
 * Without SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, prints the SQL instead (INSERT or UPDATE).
 */
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { generateApiKey, keyPrefix } from "../supabase/functions/_shared/mcp-catalog.ts";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

const email = arg("--email");
if (!email) {
  console.error(
    "Usage:\n" +
      "  npx tsx scripts/issue-mcp-key.ts --email you@example.com [--name Cursor] [--plan free]\n" +
      "  npx tsx scripts/issue-mcp-key.ts --revoke --email you@example.com [--key-prefix sav_live_abcd1234]",
  );
  process.exit(1);
}

if (flag("--revoke")) {
  await revoke(email, arg("--key-prefix"));
  process.exit(0);
}

const name = arg("--name") ?? "default";
const plan = arg("--plan") === "paid" ? "paid" : "free";

const secret = generateApiKey("live");
const key_hash = createHash("sha256").update(secret).digest("hex");
const key_prefix = keyPrefix(secret);

console.log("--- Savante MCP key (shown once; store it in the client's mcp.json) ---");
console.log(secret);
console.log("prefix:", key_prefix);
console.log("email:", email, "plan:", plan, "name:", name);
console.log("-----------------------------------------------------------------------");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.log(`
-- Apply after migrations/005_mcp_keys.sql. Paste in the SQL editor if you prefer:

insert into public.mcp_users (email, name, plan)
values (${sqlLit(email)}, ${sqlLit(name)}, ${sqlLit(plan)})
on conflict (email) do update set name = excluded.name
returning id;

-- then, with that user id:
insert into public.mcp_api_keys (user_id, name, key_prefix, key_hash)
values ('<user-id>', ${sqlLit(name)}, ${sqlLit(key_prefix)}, ${sqlLit(key_hash)});
`);
  process.exit(0);
}

const sb = createClient(url, key);
const { data: user, error: uErr } = await sb
  .from("mcp_users")
  .upsert({ email, name, plan }, { onConflict: "email" })
  .select("id")
  .single();
if (uErr) {
  console.error(uErr);
  process.exit(1);
}
const { error: kErr } = await sb.from("mcp_api_keys").insert({
  user_id: user.id,
  name,
  key_prefix,
  key_hash,
});
if (kErr) {
  console.error(kErr);
  process.exit(1);
}
console.log("Inserted mcp_users + mcp_api_keys. Secret will not be stored.");

function sqlLit(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

async function revoke(forEmail: string, prefix: string | undefined): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.log(`
-- Revoke ${prefix ? `the key with prefix ${prefix}` : "all active keys"} for ${forEmail}.
-- Paste in the SQL editor if you prefer:

update public.mcp_api_keys
set revoked_at = now()
where revoked_at is null
  and user_id = (select id from public.mcp_users where email = ${sqlLit(forEmail)})
  ${prefix ? `and key_prefix = ${sqlLit(prefix)}` : ""};
`);
    return;
  }

  const sb = createClient(url, key);
  const { data: user, error: uErr } = await sb
    .from("mcp_users")
    .select("id")
    .eq("email", forEmail)
    .maybeSingle();
  if (uErr) {
    console.error(uErr);
    process.exitCode = 1;
    return;
  }
  if (!user) {
    console.error(`No mcp_users row for ${forEmail}`);
    process.exitCode = 1;
    return;
  }

  let query = sb
    .from("mcp_api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("revoked_at", null);
  if (prefix) query = query.eq("key_prefix", prefix);

  const { data, error } = await query.select("id, key_prefix");
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }
  if (!data || data.length === 0) {
    console.log(`No active key found for ${forEmail}${prefix ? ` with prefix ${prefix}` : ""}.`);
    return;
  }
  console.log(`Revoked ${data.length} key(s) for ${forEmail}:`, data.map((k) => k.key_prefix).join(", "));
}
