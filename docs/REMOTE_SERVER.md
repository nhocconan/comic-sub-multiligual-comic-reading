# Remote Koharu

Use this when Comic Sub should share one Koharu instance across machines.

## Security model

- Koharu stays bound to `127.0.0.1:4000`.
- A reverse proxy terminates HTTPS.
- The reverse proxy validates a long Bearer token.
- The extension receives only the public HTTPS URL and Bearer token.
- Gemini/DeepSeek provider keys stay on the server in Koharu's credential
  storage; do not paste them into the extension.

Do not expose port 4000 directly to the internet. The Koharu API does not provide
its own access control.

## 1. Start Koharu on an x86-64 server

Create `.env`, add the provider keys, then run:

```bash
RUNTIME_MODE=docker bash scripts/start.sh
```

The included Compose file publishes Koharu only on `127.0.0.1:4000`. Its current
container is amd64-only. On ARM servers, install a compatible native Koharu
build instead of using that container.

## 2. Generate an auth key

```bash
bash scripts/generate-remote-auth-key.sh
```

Store the result as `BONG_BONG_AUTH_KEY` in the reverse proxy environment.

## 3. Put Caddy in front

Example `Caddyfile`:

```caddyfile
comic-be.dep.app {
	@unauthorized not header Authorization "Bearer {$BONG_BONG_AUTH_KEY}"
	respond @unauthorized 401

	reverse_proxy 127.0.0.1:4000 {
		transport http {
			read_timeout 10m
			write_timeout 10m
		}
	}
}
```

Point the domain at the server, start Caddy with
`BONG_BONG_AUTH_KEY` in its environment, and allow inbound TCP 443. Caddy obtains
and renews the TLS certificate automatically when DNS and ports are correct.

This repository also includes a ready-to-run Caddy Compose bundle:

```bash
cp deploy/remote/.env.example deploy/remote/.env
# Set the real domain and paste the generated key into deploy/remote/.env.
docker compose --env-file deploy/remote/.env \
  -f deploy/remote/docker-compose.yml up -d
```

Allow inbound TCP 80/443 and UDP 443. The Caddy container reaches only the
loopback-published Koharu service through Docker's host gateway.

### Existing Traefik host

On a server where Traefik already owns ports 80 and 443, use the production
template instead of starting the standalone Caddy bundle:

```bash
cp docker-compose.prod.yml.sample docker-compose.prod.yml
mkdir -p private
chmod 700 private
# Add five random BONG_BONG_AUTH_KEY_1..5 values to this ignored file.
openssl rand -hex 32
$EDITOR private/auth-keys.env
chmod 600 private/auth-keys.env
docker compose -f docker-compose.prod.yml up -d
```

The production gateway joins the external `traefik-network`; Koharu itself has
no published host port. Traefik terminates TLS, and the internal Caddy gateway
accepts any of the five independent Bearer keys before proxying to Koharu.
`docker-compose.prod.yml` and the entire `private/` directory are ignored, while
`docker-compose.prod.yml.sample` remains tracked as the deployment template.

## 4. Configure Comic Sub

In extension settings:

```text
Địa chỉ Koharu: https://comic-be.dep.app/api/v1
Auth key:       value from openssl rand
```

Press **Kết nối lại** and approve the one-time permission for that exact domain.
The key is stored in WebExtension local storage and added only by the background
worker to Koharu API requests. It is not sent to comic websites or content
scripts. The same endpoint and key work in desktop Chrome and Safari on iPhone
or iPad.

## Operational notes

- Translation speed depends heavily on the server CPU/GPU and upload latency.
- The browser uploads each source page to the remote Koharu instance.
- Use a private server and delete old Koharu projects periodically if storage
  retention matters.
- Rotate the Bearer key by updating Caddy and the extension together.
