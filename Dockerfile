# Build stage: install everything (TypeScript is a dev dependency) and compile.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --include=dev
COPY . .
RUN npm run build && npm prune --omit=dev

# Runtime stage: only compiled code and production dependencies.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
