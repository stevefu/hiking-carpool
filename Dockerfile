FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
CMD ["node", "server.js"]