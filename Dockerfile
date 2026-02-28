FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
ENV PORT=10000
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
