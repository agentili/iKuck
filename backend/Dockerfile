FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS build

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
COPY shared /app/shared
RUN npm ci

COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS runtime

WORKDIR /app/backend
ENV NODE_ENV=production

COPY backend/package.json backend/package-lock.json ./
COPY shared /app/shared
RUN npm ci --omit=dev

COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/src/db/migrations ./dist/db/migrations

RUN addgroup -S ikuck && adduser -S -G ikuck ikuck \
  && chown -R ikuck:ikuck /app/backend
USER ikuck

EXPOSE 3000

CMD ["node", "dist/server.js"]
