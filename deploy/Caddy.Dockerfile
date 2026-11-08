FROM caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d

COPY deploy/Caddyfile /etc/caddy/Caddyfile
RUN APP_DOMAIN=:8080 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
COPY frontend/dist /srv/frontend