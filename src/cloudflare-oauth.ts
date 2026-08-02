import { requestUrl } from "obsidian";
import { shell } from "electron";
import { createServer, Server } from "http";
import { createHash, randomBytes } from "crypto";

export const CLOUDFLARE_OAUTH_AUTHORIZE = "https://dash.cloudflare.com/oauth2/auth";
export const CLOUDFLARE_OAUTH_TOKEN = "https://dash.cloudflare.com/oauth2/token";
export const CLOUDFLARE_OAUTH_REVOKE = "https://dash.cloudflare.com/oauth2/revoke";
export const CLOUDFLARE_OAUTH_REDIRECT = "http://127.0.0.1:42813/cloudflare/callback";

export interface CloudflareOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: number;
  scope?: string;
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function callbackHtml(ok: boolean, detail: string): string {
  const title = ok ? "Cloudflare authorization approved" : "Cloudflare connection failed";
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:520px;padding:32px;border:1px solid #334155;border-radius:18px;background:#111827}h1{color:${ok ? "#4ade80" : "#fb7185"}}</style><div class="card"><h1>${title}</h1><p>${detail}</p><p>You can close this tab and return to Obsidian.</p></div>`;
}

function waitForAuthorization(expectedState: string): Promise<{ code: string; server: Server }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", CLOUDFLARE_OAUTH_REDIRECT);
        if (url.pathname !== "/cloudflare/callback") { res.writeHead(404).end(); return; }
        const error = url.searchParams.get("error");
        const detail = url.searchParams.get("error_description") ?? error ?? "Authorization denied.";
        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(callbackHtml(false, detail));
          if (!settled) { settled = true; reject(new Error(detail)); }
          server.close();
          return;
        }
        if (url.searchParams.get("state") !== expectedState) throw new Error("OAuth state did not match. Please try again.");
        const code = url.searchParams.get("code");
        if (!code) throw new Error("Cloudflare did not return an authorization code.");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(callbackHtml(true, "Authorization completed securely."));
        if (!settled) { settled = true; resolve({ code, server }); }
      } catch (error: any) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(callbackHtml(false, error?.message ?? "Invalid callback."));
        if (!settled) { settled = true; reject(error); }
        server.close();
      }
    });
    server.once("error", (error) => { if (!settled) { settled = true; reject(error); } });
    server.listen(42813, "127.0.0.1");
    window.setTimeout(() => {
      if (!settled) { settled = true; server.close(); reject(new Error("Cloudflare authorization timed out.")); }
    }, 5 * 60 * 1000);
  });
}

async function tokenRequest(params: Record<string, string>): Promise<CloudflareOAuthTokens> {
  const body = new URLSearchParams(params).toString();
  const response: any = await requestUrl({
    url: CLOUDFLARE_OAUTH_TOKEN,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  } as any);
  if (response.status >= 400) {
    let detail = response.text ?? "";
    try {
      const parsed = typeof response.json === "function" ? response.json() : JSON.parse(detail || "{}");
      detail = parsed.error_description ?? parsed.error?.message ?? parsed.error ?? detail;
    } catch { /* keep raw response */ }
    if (/invalid_client|client authentication/i.test(String(detail))) {
      throw new Error("Cloudflare rejected this OAuth client. Configure it as a public desktop client with token authentication method 'none' and PKCE S256; do not use a client secret.");
    }
    if (/invalid_grant|redirect/i.test(String(detail))) {
      throw new Error(`Cloudflare rejected the callback. The registered redirect URL must exactly equal ${CLOUDFLARE_OAUTH_REDIRECT}.`);
    }
    throw new Error(`Cloudflare token exchange failed (${response.status}): ${String(detail).slice(0, 320)}`);
  }
  const json = typeof response.json === "function" ? response.json() : JSON.parse(response.text || "{}");
  if (!json.access_token) throw new Error("Cloudflare returned no access token.");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    tokenType: json.token_type ?? "Bearer",
    expiresAt: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : undefined,
    scope: json.scope,
  };
}

export async function connectCloudflareOAuth(clientId: string): Promise<CloudflareOAuthTokens> {
  if (!clientId.trim()) throw new Error("Cloudflare OAuth Client ID is not configured by the plugin publisher.");
  const state = base64Url(randomBytes(24));
  const { verifier, challenge } = createPkce();
  const callback = waitForAuthorization(state);
  const auth = new URL(CLOUDFLARE_OAUTH_AUTHORIZE);
  auth.searchParams.set("client_id", clientId.trim());
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("redirect_uri", CLOUDFLARE_OAUTH_REDIRECT);
  auth.searchParams.set("state", state);
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("prompt", "consent");
  await shell.openExternal(auth.toString());
  const { code, server } = await callback;
  try {
    return await tokenRequest({ grant_type: "authorization_code", client_id: clientId.trim(), code, redirect_uri: CLOUDFLARE_OAUTH_REDIRECT, code_verifier: verifier });
  } finally { server.close(); }
}

export async function refreshCloudflareOAuth(clientId: string, refreshToken: string): Promise<CloudflareOAuthTokens> {
  return tokenRequest({ grant_type: "refresh_token", client_id: clientId.trim(), refresh_token: refreshToken });
}

export async function revokeCloudflareOAuth(clientId: string, token: string): Promise<void> {
  const body = new URLSearchParams({ client_id: clientId.trim(), token }).toString();
  await requestUrl({ url: CLOUDFLARE_OAUTH_REVOKE, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body } as any);
}

export async function listCloudflareAccounts(accessToken: string): Promise<CloudflareAccount[]> {
  const response: any = await requestUrl({ url: "https://api.cloudflare.com/client/v4/accounts?per_page=50", method: "GET", headers: { Authorization: `Bearer ${accessToken}` } } as any);
  if (response.status === 401) throw new Error("Cloudflare issued an unusable OAuth token. Reconnect after correcting the OAuth client configuration.");
  if (response.status === 403) throw new Error("Cloudflare approved the login but granted no account permission. Edit the OAuth client and add Account Settings Read, Workers AI Read, and Workers AI Edit, then reconnect.");
  if (response.status >= 400) throw new Error(`Could not load Cloudflare accounts (${response.status}). Ensure the OAuth client includes Account Settings Read.`);
  const json = typeof response.json === "function" ? response.json() : JSON.parse(response.text || "{}");
  return (json.result ?? []).map((account: any) => ({ id: String(account.id), name: String(account.name ?? account.id) }));
}
