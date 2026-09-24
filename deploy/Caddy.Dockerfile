FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS frontend-build

ARG VITE_GOOGLE_CLIENT_ID
ARG VITE_BUILD_ID=local
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}
ENV VITE_BUILD_ID=${VITE_BUILD_ID}

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
COPY shared /shared
RUN npm ci

COPY frontend ./
RUN npm run build

FROM caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend-build /app/dist /srv/frontend
