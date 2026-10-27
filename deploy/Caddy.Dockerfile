FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS frontend-build

ARG VITE_GOOGLE_CLIENT_ID
ARG VITE_BUILD_ID=local
ARG VITE_SOUS_CHEF=false
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}
ENV VITE_BUILD_ID=${VITE_BUILD_ID}
ENV VITE_SOUS_CHEF=${VITE_SOUS_CHEF}

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
COPY shared /shared
RUN npm ci

COPY frontend ./
RUN printf "VITE_SOUS_CHEF=%s\n" "$VITE_SOUS_CHEF" > .env.production && npm run build

FROM caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d

COPY deploy/Caddyfile /etc/caddy/Caddyfile
RUN APP_DOMAIN=:8080 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
COPY --from=frontend-build /app/dist /srv/frontend
