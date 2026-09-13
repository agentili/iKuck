FROM node:24-alpine AS frontend-build

ARG VITE_GOOGLE_CLIENT_ID
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
COPY shared /shared
RUN npm ci

COPY frontend ./
RUN npm run build

FROM caddy:2.10-alpine

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend-build /app/dist /srv/frontend
