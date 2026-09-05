---
title: Reverse proxy (HTTPS)
category: Getting started
order: 25
description: Terminate TLS in front of Terrence with Caddy or nginx so terraform login, callbacks, and webhooks work.
---

# Reverse proxy (HTTPS)

Terrence serves plain HTTP (default port 3000) and never terminates TLS itself. For anything beyond a local quickstart, put a reverse proxy in front of it. You need this because:

- `terraform login` requires the instance to be reachable over HTTPS.
- Login callbacks, webhook deliveries, registry URLs, and signed URLs are built from the instance base URL.
- Secure cookies are only set on HTTPS origins.

## Required settings

Set the public URL of the instance. It is authoritative for every generated link (login callbacks, webhooks, registry hostname, signed URLs):

```bash
PUBLIC_URL=https://terraform.example.com
```

Without `PUBLIC_URL`, Terrence derives the base URL from `X-Forwarded-Host`/`X-Forwarded-Proto` (or `Host`) when present, falling back to the connection address. That fallback is best-effort: proxy deployments should always set `PUBLIC_URL`.

Tell Terrence which proxies to trust so forwarded client addresses are honored for audit records and rate limits. The socket peer must be in one of these CIDRs before any forwarded header is read:

```bash
TERRENCE_TRUSTED_PROXY_CIDRS=127.0.0.1/32,10.0.0.0/8
```

The same trust can be managed at runtime under Site Admin settings (`general` keys `trusted-client-ip-cidrs` and `trusted-client-ip-headers`), which take precedence over the environment variable. With no trusted proxy configured, the socket peer address is authoritative and forwarded headers are ignored.

## Caddy

Caddy terminates TLS automatically (Let's Encrypt) with a three-line file:

```caddy
terraform.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy sets `X-Forwarded-Host` and `X-Forwarded-Proto` for you. Keep `PUBLIC_URL=https://terraform.example.com` and add the proxy host to `TERRENCE_TRUSTED_PROXY_CIDRS` when Caddy runs on another machine.

## nginx

Terminate TLS with certbot (or your own certificates) and forward the host and scheme explicitly:

```nginx
server {
    listen 443 ssl;
    server_name terraform.example.com;

    ssl_certificate /etc/letsencrypt/live/terraform.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/terraform.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # State uploads reach 100 MiB: raise the 1 MB default body cap.
        client_max_body_size 120m;
        # Runs stream over long-lived connections: do not cut idle reads.
        proxy_read_timeout 1h;
    }
}

server {
    listen 80;
    server_name terraform.example.com;
    return 301 https://$host$request_uri;
}
```

As with Caddy, keep `PUBLIC_URL` set to the public origin and list the nginx host in `TERRENCE_TRUSTED_PROXY_CIDRS` when it is not localhost.

## Verifying

1. Open `https://terraform.example.com` and sign in.
2. Run `terraform login terraform.example.com` from your machine. The browser flow opens against the public URL and the CLI stores the token.
3. If login still fails, check `terraform login` troubleshooting: instance reachable over HTTPS, `PUBLIC_URL` matches the origin, and the proxy forwards `Host`/`X-Forwarded-Proto`.
