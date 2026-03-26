FROM node:24-bookworm

WORKDIR /app

# 1) Install root deps (includes duroxide optional native binding on linux)
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --include=optional

# 2) Copy repo and build pilotswarm (dist/)
COPY . .
RUN npm run build

# 3) Install + build the web app
WORKDIR /app/apps/web
RUN npm ci --include=optional
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]

