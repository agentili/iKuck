FROM node:24-alpine AS build

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
COPY shared /app/shared
RUN npm ci

COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:24-alpine AS runtime

WORKDIR /app/backend
ENV NODE_ENV=production

COPY backend/package.json backend/package-lock.json ./
COPY shared /app/shared
RUN npm ci --omit=dev

COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/src/db/migrations ./dist/db/migrations

EXPOSE 3000

CMD ["node", "dist/server.js"]
