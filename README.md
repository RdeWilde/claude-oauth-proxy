# Claude OAuth Proxy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/RdeWilde/claude-oauth-proxy)

A Cloudflare Worker that provides OAuth authentication for AI provider subscriptions (Claude Pro/Max), allowing you to use your subscription as an Anthropic-compatible API endpoint.

Perfect for use with Moltworker/OpenClaw, Cline, or any tool that expects an Anthropic API key.

## Why Use This?

| Without OAuth Proxy | With OAuth Proxy |
|---------------------|------------------|
| Pay per API token ($$$) | Use your existing subscription |
| Need separate API key | OAuth with your Claude account |
| No subscription benefits | Full Pro/Max benefits |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                     │
│                                                          │
│   /auth/login    → Start OAuth flow (→ claude.ai)       │
│   /auth/callback → Receive tokens, store in R2          │
│   /v1/messages   → Proxy requests with OAuth token      │
│                                                          │
│   ┌──────────────────────────────────────────────┐      │
│   │              R2 Bucket                        │      │
│   │  • access_token                              │      │
│   │  • refresh_token                             │      │
│   │  • expires_at                                │      │
│   └──────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│               Anthropic API (api.anthropic.com)          │
│                  (with OAuth Bearer token)               │
└─────────────────────────────────────────────────────────┘
```

## Supported Providers

| Provider | Status | Subscription Types |
|----------|--------|-------------------|
| Claude   | ✅ Supported | Pro, Max |
| Gemini   | 🔜 Planned | - |

## Requirements

- Cloudflare account (free tier works)
- Claude Pro or Max subscription

## Quick Start

### Option A: One-Click Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/RdeWilde/claude-oauth-proxy)

After deploying, you'll need to:
1. Create the R2 bucket (see [Setup R2 Bucket](#2-create-r2-bucket))
2. Set the admin secret (see [Set Admin Secret](#3-set-admin-secret))

### Option B: Manual Setup

#### 1. Clone and install dependencies

```bash
git clone https://github.com/RdeWilde/claude-oauth-proxy.git
cd claude-oauth-proxy
npm install
```

#### 2. Create R2 Bucket

<details>
<summary><strong>Via Cloudflare Dashboard (Recommended)</strong></summary>

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **R2 Object Storage** in the sidebar
3. Click **Create bucket**
4. Enter bucket name: `oauth-proxy-tokens`
5. Click **Create bucket**

</details>

<details>
<summary><strong>Via CLI</strong></summary>

```bash
npx wrangler r2 bucket create oauth-proxy-tokens
```

</details>

#### 3. Set Admin Secret

<details>
<summary><strong>Via Cloudflare Dashboard (Recommended)</strong></summary>

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **Workers & Pages**
3. Click on your `claude-oauth-proxy` worker
4. Go to **Settings** → **Variables and Secrets**
5. Under **Secrets**, click **Add**
6. Name: `ADMIN_SECRET`
7. Value: Generate a secure value (e.g., run `openssl rand -base64 32` locally)
8. Click **Save**

</details>

<details>
<summary><strong>Via CLI</strong></summary>

```bash
# Generate a secure secret
openssl rand -base64 32

# Store as Wrangler secret
npx wrangler secret put ADMIN_SECRET
# Paste the generated value when prompted
```

</details>

#### 4. Deploy the Worker

<details>
<summary><strong>Via Cloudflare Dashboard</strong></summary>

1. Go to **Workers & Pages** → **Create**
2. Select **Import from GitHub**
3. Connect your GitHub account and select the `claude-oauth-proxy` repository
4. Click **Deploy**

</details>

<details>
<summary><strong>Via CLI</strong></summary>

```bash
npm run deploy
```

</details>

#### 5. Authenticate with Claude

1. Open the Worker URL in your browser: `https://claude-oauth-proxy.<your-subdomain>.workers.dev`
2. Click **"Login with Claude"**
3. Click **"Open Authorization Page"** to open Claude's auth in a new tab
4. Log in and authorize the application
5. Copy the authorization code shown on the page
6. Paste the code back into the Worker form
7. Click **"Complete Authentication"**

## Cloudflare AI Gateway Integration

This proxy is fully compatible with [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) and can be added as a **Custom Provider** for caching, analytics, rate limiting, and more.

### Architecture with AI Gateway

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Your App    │────▶│  AI Gateway      │────▶│  OAuth Proxy     │────▶│  Anthropic  │
│  (Moltworker)│     │  (caching, etc)  │     │  (this worker)   │     │  API        │
└──────────────┘     └──────────────────┘     └──────────────────┘     └─────────────┘
                            │
                            ▼
                     ┌──────────────────┐
                     │  • Caching       │
                     │  • Rate limiting │
                     │  • Analytics     │
                     │  • Logging       │
                     └──────────────────┘
```

### Setting Up Custom Provider

<details>
<summary><strong>Via Cloudflare Dashboard (Recommended)</strong></summary>

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **Compute & AI** → **AI Gateway** → **Custom Providers**
3. Click **Add Custom Provider**
4. Fill in:
   - **Provider Name**: `Claude OAuth Proxy`
   - **Provider Slug**: `claude-oauth`
   - **Base URL**: `https://claude-oauth-proxy.<your-subdomain>.workers.dev`
5. Click **Save**

</details>

<details>
<summary><strong>Via API</strong></summary>

```bash
# Create a Cloudflare API token with "AI Gateway - Edit" permission first
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<account_id>/ai-gateway/custom-providers" \
  -H "Authorization: Bearer <cloudflare_api_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Claude OAuth Proxy",
    "slug": "claude-oauth",
    "base_url": "https://claude-oauth-proxy.<your-subdomain>.workers.dev",
    "description": "Claude Pro/Max subscription via OAuth proxy",
    "enable": true
  }'
```

</details>

### Using the Custom Provider

Once created, use it via AI Gateway with the `custom-` prefix:

```bash
# Via AI Gateway (note: custom- prefix is required)
curl "https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_name>/custom-claude-oauth/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Benefits of AI Gateway + OAuth Proxy

| Feature | Description |
|---------|-------------|
| **Cost Savings** | Use your flat-rate subscription instead of per-token API pricing |
| **Caching** | Cache repeated requests to reduce latency and usage |
| **Analytics** | Track usage, costs, and performance metrics |
| **Rate Limiting** | Protect against runaway usage |
| **Logging** | Debug and audit API calls |
| **Fallbacks** | Configure fallback providers if needed |

## Usage Examples

### Direct Usage (Without AI Gateway)

#### With curl

```bash
curl https://claude-oauth-proxy.<your-subdomain>.workers.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

#### With Python

```python
import anthropic

client = anthropic.Anthropic(
    base_url="https://claude-oauth-proxy.<your-subdomain>.workers.dev",
    api_key="dummy"  # Not used but required
)

message = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content)
```

#### With Node.js / TypeScript

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'https://claude-oauth-proxy.<your-subdomain>.workers.dev',
  apiKey: 'dummy', // Not used but required
});

const message = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### With Moltworker/OpenClaw

For [Moltworker](https://github.com/cloudflare/moltworker), set the OAuth Proxy as your AI Gateway:

```bash
npx wrangler secret put AI_GATEWAY_BASE_URL
# Enter: https://claude-oauth-proxy.<your-subdomain>.workers.dev

npx wrangler secret put AI_GATEWAY_API_KEY
# Enter: dummy (not used but required by Moltworker)
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Status page with authentication info |
| `/auth/login` | GET | Start OAuth flow (default provider) |
| `/auth/login/:provider` | GET | Start OAuth flow for specific provider |
| `/auth/callback` | POST | Submit authorization code |
| `/auth/status` | GET | JSON status of all providers |
| `/auth/logout` | POST | Clear all tokens (requires ADMIN_SECRET) |
| `/auth/logout/:provider` | POST | Clear tokens for specific provider |
| `/v1/*` | * | Proxy to Anthropic API |

## Token Management

The Worker automatically handles token refresh:
- Tokens are checked on every API request
- If a token expires within 5 minutes, it's automatically refreshed
- If Anthropic returns 401, the proxy tries one refresh+retry (no hammering)
- Refresh tokens are stored securely in R2
- No manual intervention needed

## How It Works (Technical Details)

OAuth tokens from Claude are restricted to Claude Code only. This proxy makes requests appear as Claude Code by:

1. **Adding required headers:**
   - `anthropic-beta: oauth-2025-04-20`
   - `User-Agent: claude-cli/2.1.2 (external, cli)`

2. **Adding system prompt prefix:**
   - Prepends "You are Claude Code, Anthropic's official CLI for Claude." to all requests

3. **Removing conflicting headers:**
   - Removes `x-api-key` (replaced with OAuth Bearer token)

This is the same approach used by [OpenCode](https://github.com/sst/opencode).

## Security

### Recommendations

1. **Cloudflare Access** - Add Cloudflare Access to protect the `/auth/*` endpoints
2. **Custom domain** - Use a custom domain instead of workers.dev
3. **IP restrictions** - Configure allowed IPs in your Worker

### Adding Cloudflare Access

1. Go to Cloudflare Dashboard → Zero Trust → Access → Applications
2. Add a new Self-hosted application
3. Set the application domain to your Worker URL
4. Protect paths: `/auth/*`
5. Configure your desired authentication policy

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_SECRET` | Yes | Secret for admin endpoints (logout) |
| `CLAUDE_CLIENT_ID` | No | OAuth client ID (defaults to Claude Code's) |
| `CLAUDE_SCOPES` | No | OAuth scopes |
| `DEFAULT_PROVIDER` | No | Default provider for `/auth/login` |

## Troubleshooting

### "OAuth authentication is currently not supported"
Make sure you're running the latest version. The proxy must add specific headers (`anthropic-beta: oauth-2025-04-20`) and a system prompt prefix. Redeploy from the latest code.

### "This credential is only authorized for use with Claude Code"
Same fix as above - the proxy needs the system prompt prefix to make requests appear as Claude Code.

### "Session Expired"
The OAuth session expired. Start again via `/auth/login`.

### "Token refresh failed"
Your refresh token may have expired. Go to `/auth/login` to re-authenticate.

### "Not authenticated"
Not logged in yet. Visit the Worker root URL and click "Login with Claude".

### "Code challenge failed"
The PKCE verification failed. This usually means the code expired or you're using an old authorization URL. Start the flow again from `/auth/login`.

### Rate limits
Claude Pro/Max has usage limits that reset every 5 hours. Check your usage at [claude.ai](https://claude.ai).

## Future Plans

- **Gemini support**: Add Google Gemini OAuth for Gemini Advanced subscribers
- **Multiple accounts**: Support for multiple Claude accounts with load balancing
- **Usage tracking**: Track and display API usage statistics

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Credits

- OAuth implementation based on [Claude Code](https://github.com/anthropics/claude-code) and [OpenCode](https://github.com/sst/opencode)
- Inspired by [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- Built for use with [Moltworker](https://github.com/cloudflare/moltworker)
