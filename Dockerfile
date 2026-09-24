FROM node:22-alpine

# git reads the mounted repos for the recent commits feed
RUN apk add --no-cache git \
 && mkdir -p /run/btop \
 && chown node:node /run/btop

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY server.js ./
COPY public ./public
COPY themes ./themes

USER node
EXPOSE 8080
CMD ["node", "server.js"]
