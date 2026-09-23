FROM node:22-alpine

# git reads the mounted repos for the recent commits feed
RUN apk add --no-cache git

WORKDIR /app
COPY server.js ./
COPY public ./public

USER node
EXPOSE 8080
CMD ["node", "server.js"]
