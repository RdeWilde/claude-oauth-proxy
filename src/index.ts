/**
 * Claude OAuth Proxy for Cloudflare Workers
 * 
 * Uses the same OAuth flow as OpenCode - redirects to Anthropic's callback page
 * which displays the code for manual entry.
 * 
 * Endpoints:
 * - GET  /                     - Status page
 * - GET  /auth/login           - Start OAuth flow
 * - GET  /auth/login/:provider - Start OAuth flow for specific provider
 * - POST /auth/callback        - Submit authorization code
 * - GET  /auth/status          - Check authentication status (JSON)
 * - POST /auth/logout          - Clear stored tokens (requires ADMIN_SECRET)
 * - *    /v1/*                 - Anthropic-compatible API proxy
 */

export interface Env {
  TOKEN_STORE: R2Bucket;
  ADMIN_SECRET: string;
  CLAUDE_CLIENT_ID: string;
  CLAUDE_SCOPES: string;
  DEFAULT_PROVIDER: string;
}

// ============================================================================
// Types
// ============================================================================

interface OAuthTokens {
  provider: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
}

interface PKCEState {
  provider: string;
  verifier: string;
  state: string;
  created_at: number;
}

interface ProviderConfig {
  name: string;
  displayName: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
  clientId: string;
  scopes: string;
  // Anthropic's callback URL that displays the code
  callbackUrl: string;
}

// ============================================================================
// Provider Configurations
// ============================================================================

function getProviderConfig(provider: string, env: Env): ProviderConfig | null {
  switch (provider.toLowerCase()) {
    case 'claude':
    case 'anthropic':
      return {
        name: 'claude',
        displayName: 'Claude',
        authorizeUrl: 'https://claude.ai/oauth/authorize',
        tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
        apiBaseUrl: 'https://api.anthropic.com',
        clientId: env.CLAUDE_CLIENT_ID,
        scopes: env.CLAUDE_SCOPES,
        // This is Anthropic's official callback that displays the code
        callbackUrl: 'https://console.anthropic.com/oauth/code/callback',
      };
    
    default:
      return null;
  }
}

function getSupportedProviders(): string[] {
  return ['claude'];
}

// ============================================================================
// Storage Keys
// ============================================================================

const getTokenKey = (provider: string) => `tokens-${provider}.json`;
const PKCE_KEY = 'pkce-state.json';

// ============================================================================
// PKCE Helpers
// ============================================================================

function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => chars[byte % chars.length]).join('');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(hash);
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ============================================================================
// R2 Storage Helpers
// ============================================================================

async function getTokens(bucket: R2Bucket, provider: string): Promise<OAuthTokens | null> {
  try {
    const object = await bucket.get(getTokenKey(provider));
    if (!object) return null;
    return JSON.parse(await object.text()) as OAuthTokens;
  } catch {
    return null;
  }
}

async function saveTokens(bucket: R2Bucket, tokens: OAuthTokens): Promise<void> {
  await bucket.put(getTokenKey(tokens.provider), JSON.stringify(tokens, null, 2), {
    httpMetadata: { contentType: 'application/json' }
  });
}

async function deleteTokens(bucket: R2Bucket, provider: string): Promise<void> {
  await bucket.delete(getTokenKey(provider));
}

async function getPKCEState(bucket: R2Bucket): Promise<PKCEState | null> {
  try {
    const object = await bucket.get(PKCE_KEY);
    if (!object) return null;
    return JSON.parse(await object.text()) as PKCEState;
  } catch {
    return null;
  }
}

async function savePKCEState(bucket: R2Bucket, pkce: PKCEState): Promise<void> {
  await bucket.put(PKCE_KEY, JSON.stringify(pkce), {
    httpMetadata: { contentType: 'application/json' }
  });
}

async function deletePKCEState(bucket: R2Bucket): Promise<void> {
  await bucket.delete(PKCE_KEY);
}

// ============================================================================
// OAuth Flow
// ============================================================================

async function startOAuthFlow(request: Request, env: Env, provider: string): Promise<Response> {
  const config = getProviderConfig(provider, env);
  if (!config) {
    return new Response(renderHTML('Error', `
      <div class="error">
        <h2>Unknown Provider</h2>
        <p>Provider "${escapeHtml(provider)}" is not supported.</p>
        <p>Supported providers: ${getSupportedProviders().join(', ')}</p>
        <a href="/" class="button">Back</a>
      </div>
    `), { status: 400, headers: { 'Content-Type': 'text/html' } });
  }

  // Generate PKCE values
  // OpenCode uses the verifier as the state parameter
  const verifier = generateRandomString(64);
  const state = verifier; // Use verifier as state (like OpenCode)
  const codeChallenge = await generateCodeChallenge(verifier);
  
  // Save PKCE state to R2
  await savePKCEState(env.TOKEN_STORE, {
    provider: config.name,
    verifier,
    state,
    created_at: Date.now()
  });
  
  // Build authorization URL - uses Anthropic's callback URL
  // Match OpenCode's parameter order
  const authUrl = new URL(config.authorizeUrl);
  authUrl.searchParams.set('code', 'true');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', config.callbackUrl);
  authUrl.searchParams.set('scope', config.scopes);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  
  const url = new URL(request.url);
  
  // Show instructions page with link to authorize
  return new Response(renderHTML('Login with Claude', `
    <div class="info">
      <h2>Step 1: Authorize</h2>
      <p>Click the button below to open Claude's authorization page in a new tab.</p>
      <p><a href="${escapeHtml(authUrl.toString())}" target="_blank" class="button">Open Authorization Page →</a></p>
    </div>
    
    <div class="info">
      <h2>Step 2: Copy the Code</h2>
      <p>After authorizing, you'll see a page with an authorization code. Copy that code.</p>
      <p><small>The code looks like: <code>abc123...xyz#${state.substring(0, 8)}...</code></small></p>
    </div>
    
    <div class="info">
      <h2>Step 3: Paste Below</h2>
      <form method="POST" action="/auth/callback" class="code-form">
        <label for="code">Authorization Code:</label>
        <input type="text" id="code" name="code" placeholder="Paste the code here" required 
               style="width: 100%; padding: 12px; margin: 8px 0; font-family: monospace; font-size: 14px; 
                      background: #1e293b; border: 1px solid #475569; border-radius: 6px; color: #e2e8f0;">
        <button type="submit" class="button" style="margin-top: 12px;">Complete Authentication</button>
      </form>
    </div>
    
    <p style="color: #64748b; font-size: 0.9em;">
      Note: This flow is the same as OpenCode and Claude Code use. The code expires quickly, so complete this within a few minutes.
    </p>
  `), { headers: { 'Content-Type': 'text/html' } });
}

async function handleCodeSubmission(request: Request, env: Env): Promise<Response> {
  // Parse form data
  const formData = await request.formData();
  let code = formData.get('code') as string | null;
  
  if (!code) {
    return new Response(renderHTML('Error', `
      <div class="error">
        <h2>Missing Code</h2>
        <p>No authorization code was provided.</p>
        <a href="/auth/login" class="button">Try Again</a>
      </div>
    `), { status: 400, headers: { 'Content-Type': 'text/html' } });
  }
  
  // Claude returns code in format: CODE#STATE
  // We need to extract just the code part
  let receivedState: string | null = null;
  if (code.includes('#')) {
    const parts = code.split('#');
    code = parts[0];
    receivedState = parts[1] || null;
  }
  
  // Retrieve PKCE state
  const pkce = await getPKCEState(env.TOKEN_STORE);
  if (!pkce) {
    return new Response(renderHTML('Error', `
      <div class="error">
        <h2>Session Expired</h2>
        <p>Your authentication session has expired. Please start over.</p>
        <a href="/auth/login" class="button">Start Again</a>
      </div>
    `), { status: 400, headers: { 'Content-Type': 'text/html' } });
  }
  
  // Validate state if provided (optional but recommended)
  if (receivedState && receivedState !== pkce.state) {
    console.warn('State mismatch - received:', receivedState, 'expected:', pkce.state);
    // Don't fail on state mismatch since some flows might not include it
  }
  
  // Get provider config
  const config = getProviderConfig(pkce.provider, env);
  if (!config) {
    await deletePKCEState(env.TOKEN_STORE);
    return new Response(renderHTML('Error', `
      <div class="error">
        <h2>Configuration Error</h2>
        <p>Provider configuration not found.</p>
        <a href="/" class="button">Back</a>
      </div>
    `), { status: 400, headers: { 'Content-Type': 'text/html' } });
  }
  
  // Exchange code for tokens
  try {
    // OpenCode includes state in the token exchange body
    const tokenBody = {
      code: code,
      state: receivedState || pkce.state,
      grant_type: 'authorization_code',
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      code_verifier: pkce.verifier,
    };
    
    console.log('Token exchange request to:', config.tokenUrl);
    
    const tokenResponse = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(tokenBody),
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Token exchange failed:', errorText);
      await deletePKCEState(env.TOKEN_STORE);
      
      let errorMessage = errorText;
      let errorDetails = '';
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error_description || errorJson.error || 'Unknown error';
        if (errorJson.error) {
          errorDetails = `<p><strong>Error code:</strong> ${escapeHtml(errorJson.error)}</p>`;
        }
      } catch {
        // Keep original errorText
      }
      
      return new Response(renderHTML('Error', `
        <div class="error">
          <h2>Token Exchange Failed</h2>
          <p>${escapeHtml(String(errorMessage))}</p>
          ${errorDetails}
          <p><small>Status: ${tokenResponse.status}</small></p>
          <details style="margin-top: 1rem;">
            <summary style="cursor: pointer; color: #94a3b8;">Show raw response</summary>
            <pre style="margin-top: 0.5rem; font-size: 0.8em;">${escapeHtml(errorText)}</pre>
          </details>
          <a href="/auth/login" class="button" style="margin-top: 1rem;">Try Again</a>
        </div>
      `), { status: 400, headers: { 'Content-Type': 'text/html' } });
    }
    
    const tokenData = await tokenResponse.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
    };
    
    // Calculate expiry time
    const expiresAt = Date.now() + (tokenData.expires_in * 1000);
    
    // Save tokens
    await saveTokens(env.TOKEN_STORE, {
      provider: config.name,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: expiresAt,
      token_type: tokenData.token_type || 'Bearer',
    });
    
    // Clear PKCE state
    await deletePKCEState(env.TOKEN_STORE);
    
    // Success!
    return new Response(renderHTML('Success', `
      <div class="success">
        <h2>✅ Authentication Successful!</h2>
        <p>You have successfully authenticated with <strong>${config.displayName}</strong>.</p>
        <p>Token expires: ${new Date(expiresAt).toLocaleString()}</p>
        <p>The proxy will automatically refresh the token when needed.</p>
        <a href="/" class="button">View Status & Usage</a>
      </div>
    `), { headers: { 'Content-Type': 'text/html' } });
    
  } catch (error) {
    console.error('OAuth error:', error);
    await deletePKCEState(env.TOKEN_STORE);
    return new Response(renderHTML('Error', `
      <div class="error">
        <h2>Authentication Error</h2>
        <p>${escapeHtml(String(error))}</p>
        <a href="/auth/login" class="button">Try Again</a>
      </div>
    `), { status: 500, headers: { 'Content-Type': 'text/html' } });
  }
}

// ============================================================================
// Token Refresh
// ============================================================================

async function refreshAccessToken(bucket: R2Bucket, tokens: OAuthTokens, env: Env): Promise<OAuthTokens | null> {
  const config = getProviderConfig(tokens.provider, env);
  if (!config) {
    console.error('refreshAccessToken: Provider config not found for', tokens.provider);
    return null;
  }
  
  try {
    console.log(`Attempting token refresh for ${tokens.provider}...`);
    
    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: config.clientId,
        refresh_token: tokens.refresh_token,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Token refresh failed (${response.status}):`, errorText);
      
      // If refresh token is invalid/expired, we need to re-authenticate
      if (response.status === 400 || response.status === 401) {
        console.error('Refresh token appears to be invalid or expired');
      }
      return null;
    }
    
    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    };
    
    console.log(`Token refresh successful, expires_in: ${data.expires_in}s, new refresh_token: ${data.refresh_token ? 'yes' : 'no'}`);
    
    const newTokens: OAuthTokens = {
      provider: tokens.provider,
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + (data.expires_in * 1000),
      token_type: data.token_type || 'Bearer',
    };
    
    await saveTokens(bucket, newTokens);
    console.log(`New tokens saved, expires_at: ${new Date(newTokens.expires_at).toISOString()}`);
    return newTokens;
  } catch (error) {
    console.error('Token refresh exception:', error);
    return null;
  }
}

// ============================================================================
// API Proxy
// ============================================================================

async function proxyToProvider(request: Request, env: Env, provider: string): Promise<Response> {
  const config = getProviderConfig(provider, env);
  if (!config) {
    return jsonResponse({ error: 'Unknown provider' }, 400);
  }
  
  let tokens = await getTokens(env.TOKEN_STORE, provider);
  
  if (!tokens) {
    return jsonResponse({
      error: 'Not authenticated',
      message: `Please authenticate with ${config.displayName} first`,
      login_url: `/auth/login/${provider}`
    }, 401);
  }
  
  // Check if token needs refresh (5 minute buffer)
  const refreshBuffer = 5 * 60 * 1000;
  if (tokens.expires_at - Date.now() < refreshBuffer) {
    console.log(`Token expiring soon for ${provider} (expires_at: ${new Date(tokens.expires_at).toISOString()}), refreshing...`);
    const newTokens = await refreshAccessToken(env.TOKEN_STORE, tokens, env);
    if (newTokens) {
      console.log(`Token refreshed successfully, new expiry: ${new Date(newTokens.expires_at).toISOString()}`);
      tokens = newTokens;
    } else {
      console.error('Token refresh failed, returning 401');
      return jsonResponse({
        error: 'Token refresh failed',
        message: 'Please re-authenticate',
        login_url: `/auth/login/${provider}`
      }, 401);
    }
  }
  
  // Build target URL
  const url = new URL(request.url);
  const targetUrl = new URL(url.pathname + url.search, config.apiBaseUrl);
  
  // Clone request headers and add OAuth auth
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${tokens.access_token}`);
  headers.delete('Host');
  headers.delete('x-api-key'); // Remove any API key - we use OAuth instead
  
  // Required headers for OAuth authentication (like OpenCode/Claude Code)
  // Merge with any existing beta headers
  const existingBeta = headers.get('anthropic-beta') || '';
  const existingBetas = existingBeta.split(',').map(b => b.trim()).filter(Boolean);
  const requiredBetas = ['oauth-2025-04-20'];
  const mergedBetas = [...new Set([...requiredBetas, ...existingBetas])].join(',');
  headers.set('anthropic-beta', mergedBetas);
  headers.set('User-Agent', 'claude-cli/2.1.2 (external, cli)');
  
  // Get request body once (streams can only be read once)
  let requestBody = request.method !== 'GET' && request.method !== 'HEAD' 
    ? await request.text() 
    : undefined;
  
  // Transform request body to look like Claude Code (required for OAuth tokens)
  if (requestBody) {
    try {
      const parsed = JSON.parse(requestBody);
      
      // Add Claude Code system prompt prefix (required for OAuth)
      const CLAUDE_CODE_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
      
      if (parsed.system) {
        if (typeof parsed.system === 'string') {
          parsed.system = CLAUDE_CODE_PREFIX + "\n\n" + parsed.system;
        } else if (Array.isArray(parsed.system)) {
          // System is array of content blocks
          parsed.system.unshift({ type: 'text', text: CLAUDE_CODE_PREFIX });
        }
      } else {
        parsed.system = CLAUDE_CODE_PREFIX;
      }
      
      requestBody = JSON.stringify(parsed);
    } catch (e) {
      // Not JSON or parse error, send as-is
      console.log('Could not parse request body as JSON:', e);
    }
  }
  
  try {
    let response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: headers,
      body: requestBody,
    });
    
    // If we get a 401, try refreshing the token and retry ONCE only
    if (response.status === 401) {
      console.log('Received 401 from Anthropic API, attempting token refresh (one retry only)...');
      const newTokens = await refreshAccessToken(env.TOKEN_STORE, tokens, env);
      
      if (!newTokens) {
        console.error('Token refresh failed after 401');
        return jsonResponse({
          error: 'Authentication failed',
          message: 'Token refresh failed. Please re-authenticate.',
          login_url: `/auth/login/${provider}`
        }, 401);
      }
      
      console.log('Token refreshed after 401, retrying request once...');
      tokens = newTokens;
      headers.set('Authorization', `Bearer ${tokens.access_token}`);
      
      response = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: headers,
        body: requestBody,
      });
      
      // If still 401 after refresh, don't retry again - return error
      if (response.status === 401) {
        console.error('Still getting 401 after token refresh - not retrying again');
        return jsonResponse({
          error: 'Authentication failed',
          message: 'Request failed after token refresh. Please re-authenticate.',
          login_url: `/auth/login/${provider}`
        }, 401);
      }
    }
    
    // Add CORS headers
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return jsonResponse({ error: 'Proxy error', message: String(error) }, 502);
  }
}

// ============================================================================
// Auth Status & Logout
// ============================================================================

async function getAuthStatus(env: Env): Promise<Response> {
  const providers = getSupportedProviders();
  const status: Record<string, { authenticated: boolean; expires_at?: number; expires_in?: number }> = {};
  
  for (const provider of providers) {
    const tokens = await getTokens(env.TOKEN_STORE, provider);
    if (tokens) {
      status[provider] = {
        authenticated: true,
        expires_at: tokens.expires_at,
        expires_in: Math.max(0, Math.floor((tokens.expires_at - Date.now()) / 1000))
      };
    } else {
      status[provider] = { authenticated: false };
    }
  }
  
  return jsonResponse(status);
}

async function handleLogout(request: Request, env: Env, provider?: string): Promise<Response> {
  // Verify admin secret
  const authHeader = request.headers.get('Authorization');
  const apiKey = request.headers.get('X-API-Key');
  const secret = authHeader?.replace('Bearer ', '') || apiKey;
  
  if (secret !== env.ADMIN_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  
  if (provider) {
    await deleteTokens(env.TOKEN_STORE, provider);
    return jsonResponse({ success: true, message: `Logged out of ${provider}` });
  } else {
    for (const p of getSupportedProviders()) {
      await deleteTokens(env.TOKEN_STORE, p);
    }
    return jsonResponse({ success: true, message: 'Logged out of all providers' });
  }
}

// ============================================================================
// HTML Helpers
// ============================================================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function escapeHtml(text: unknown): string {
  const str = typeof text === 'string' ? text : String(text ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderHTML(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Claude OAuth Proxy</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
      background: #0f172a;
      color: #e2e8f0;
    }
    h1, h2, h3 { color: #f8fafc; margin-top: 0; }
    a { color: #60a5fa; }
    code, pre {
      background: #1e293b;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.9em;
    }
    code { padding: 0.2em 0.4em; border-radius: 4px; }
    pre { padding: 1rem; border-radius: 8px; overflow-x: auto; }
    .button {
      display: inline-block;
      background: #3b82f6;
      color: white;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 500;
      border: none;
      cursor: pointer;
      font-size: 1rem;
    }
    .button:hover { background: #2563eb; }
    .button.secondary { background: #475569; }
    .button.secondary:hover { background: #64748b; }
    .success {
      background: #064e3b;
      border: 1px solid #10b981;
      padding: 1.5rem;
      border-radius: 8px;
      margin: 1rem 0;
    }
    .error {
      background: #450a0a;
      border: 1px solid #ef4444;
      padding: 1.5rem;
      border-radius: 8px;
      margin: 1rem 0;
    }
    .info {
      background: #1e293b;
      padding: 1.5rem;
      border-radius: 8px;
      margin: 1rem 0;
    }
    .status-card {
      background: #1e293b;
      padding: 1.5rem;
      border-radius: 8px;
      margin: 1rem 0;
      border-left: 4px solid #475569;
    }
    .status-card.authenticated { border-left-color: #10b981; }
    .status-card.unauthenticated { border-left-color: #f59e0b; }
    .status-card.expired { border-left-color: #ef4444; }
    label { display: block; margin-bottom: 4px; font-weight: 500; }
  </style>
</head>
<body>
  <h1>🔐 Claude OAuth Proxy</h1>
  ${content}
  <footer style="margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #334155; color: #64748b; font-size: 0.9em;">
    <p>Powered by Cloudflare Workers + R2 | <a href="https://github.com/RdeWilde/claude-oauth-proxy">GitHub</a></p>
  </footer>
</body>
</html>`;
}

async function renderStatusPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const claudeTokens = await getTokens(env.TOKEN_STORE, 'claude');
  
  let statusCard = '';
  
  if (claudeTokens) {
    const now = Date.now();
    const expiresIn = Math.max(0, Math.floor((claudeTokens.expires_at - now) / 1000));
    const isExpired = claudeTokens.expires_at < now;
    const expiresDate = new Date(claudeTokens.expires_at).toLocaleString();
    const statusClass = isExpired ? 'expired' : 'authenticated';
    
    statusCard = `
      <div class="status-card ${statusClass}">
        <h3>🤖 Claude</h3>
        <p><strong>Status:</strong> ${isExpired ? '⚠️ Token Expired' : '✅ Authenticated'}</p>
        <p><strong>Expires:</strong> ${expiresDate}</p>
        <p><strong>Expires in:</strong> ${isExpired ? 'Expired (will auto-refresh on next request)' : `${Math.floor(expiresIn / 60)} minutes`}</p>
        <a href="/auth/login/claude" class="button secondary">Re-authenticate</a>
      </div>
    `;
  } else {
    statusCard = `
      <div class="status-card unauthenticated">
        <h3>🤖 Claude</h3>
        <p><strong>Status:</strong> ⚠️ Not authenticated</p>
        <p>Works with Claude Pro ($20/mo) and Max ($100/mo) subscriptions.</p>
        <a href="/auth/login/claude" class="button">Login with Claude</a>
      </div>
    `;
  }
  
  const usageSection = claudeTokens ? `
    <div class="info">
      <h3>📖 Usage</h3>
      <p>Use this URL as your Anthropic API base URL:</p>
      <pre>${url.origin}</pre>
      
      <h4>Example with curl:</h4>
      <pre>curl ${url.origin}/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'</pre>

      <h4>With Python SDK:</h4>
      <pre>import anthropic

client = anthropic.Anthropic(
    base_url="${url.origin}",
    api_key="dummy"  # Not used but required
)

message = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)</pre>

      <h4>For Moltworker / OpenClaw:</h4>
      <pre>npx wrangler secret put AI_GATEWAY_BASE_URL
# Enter: ${url.origin}

npx wrangler secret put AI_GATEWAY_API_KEY
# Enter: dummy</pre>
    </div>
  ` : '';
  
  const content = `
    <p>Use your Claude Pro/Max subscription as an API endpoint. Same OAuth flow as 
    <a href="https://opencode.ai">OpenCode</a> and Claude Code.</p>
    
    <h2>🔌 Provider Status</h2>
    ${statusCard}
    
    ${usageSection}
    
    <div class="info">
      <h3>ℹ️ About</h3>
      <p>Tokens are stored securely in Cloudflare R2 and automatically refreshed when needed.</p>
      <p>This proxy is fully compatible with the Anthropic API and can be used with any tool that supports custom base URLs.</p>
    </div>
  `;
  
  return new Response(renderHTML('Status', content), {
    headers: { 'Content-Type': 'text/html' }
  });
}

// ============================================================================
// Main Router
// ============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, anthropic-version',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    
    // Status page
    if (path === '/') {
      return renderStatusPage(request, env);
    }
    
    // OAuth: login with specific provider
    if (path.startsWith('/auth/login/')) {
      const provider = path.replace('/auth/login/', '');
      return startOAuthFlow(request, env, provider);
    }
    
    // OAuth: login with default provider
    if (path === '/auth/login') {
      return startOAuthFlow(request, env, env.DEFAULT_PROVIDER || 'claude');
    }
    
    // OAuth: callback (POST - form submission with code)
    if (path === '/auth/callback' && request.method === 'POST') {
      return handleCodeSubmission(request, env);
    }
    
    // OAuth: status (JSON)
    if (path === '/auth/status') {
      return getAuthStatus(env);
    }
    
    // OAuth: logout
    if (path.startsWith('/auth/logout')) {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      const provider = path.replace('/auth/logout/', '').replace('/auth/logout', '');
      return handleLogout(request, env, provider || undefined);
    }
    
    // Anthropic API proxy
    if (path.startsWith('/v1/')) {
      return proxyToProvider(request, env, 'claude');
    }
    
    return new Response('Not found', { status: 404 });
  },
};
